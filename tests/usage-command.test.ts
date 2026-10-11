import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { FORGE_COMMAND_DISCOVERY_EVENT } from "@zihanw/pi-forge/command-contribution";
import { createForgeAgentArgumentCompletions, createForgeAgentCommandHandler, parseUsageArgs, registerForgeAgentCommand } from "../src/command/forge-agent.ts";
import { backgroundTasksFor } from "../src/runtime/background-tasks.ts";
import { renderSubagentUsageReport, shortUsageTaskId, subagentUsageTasks, usageTaskLabels } from "../src/usage/report.ts";

function usage(n = 1, known = n) {
	return { requests: { total: n, cacheKnown: known, usageKnown: known }, tokens: { input: 10 * n, output: 5 * n, cacheRead: 2 * known, cacheWrite: known, total: 15 * n + 3 * known }, cost: { currency: "USD", amount: 0.01 * known } };
}
function run(runId = "REAL-RESPONSE-UUID-NEVER-DISPLAY", taskId = "t1", n = 1, known = n, model = { provider: "auto", id: "selected-model" }) {
	return { runId, taskId, profileId: "project:worker", model, status: "completed", usage: usage(n, known) };
}
function envelope(runs = [run()]) {
	return { type: "message", id: "entry", message: { role: "toolResult", toolName: "codemode", details: { forgeSubagentUsage: { schemaVersion: 1, runs } }, usage: { input: 999999 } } };
}
function context(entries: unknown[] = []) {
	const texts: string[] = [], warnings: string[] = [];
	const state = { entries, leaf: "home", session: "session", cwd: "/parent" };
	const ctx: any = {
		get cwd() { return state.cwd; }, hasUI: true,
		sessionManager: { getBranch: () => state.entries, getLeafId: () => state.leaf, getSessionId: () => state.session, getEntries: () => state.entries },
		ui: { editor: async (_title: string, text: string) => { texts.push(text); }, notify: (text: string) => warnings.push(text) },
		modelRegistry: new Proxy({}, { get: () => { throw new Error("no registry/auth/model lookup"); } }),
	};
	return { ctx, texts, warnings, state };
}
function runtime(extra: Record<string, unknown> = {}): any {
	const forbidden = () => { throw new Error("usage must not execute/prepare/collect runtime reports"); };
	return { prepare: forbidden, execute: forbidden, takeReport: forbidden, descriptors: forbidden, ...extra };
}

test("usage aggregates only deduped receipts, persists across replay and gives selected model/task details", async () => {
	const r1 = run(), r2 = run("second-delta", "t1", 2), r3 = run("third", "t2", 1, 1, { provider: "other", id: "m" });
	const entries = [envelope([r1, r2, r3]), envelope([r1]), { type: "message", message: { role: "toolResult", toolName: "bash", usage: { input: 555555 } } }];
	const { ctx, texts, warnings } = context(entries);
	const handler = createForgeAgentCommandHandler(runtime(), () => undefined);
	await handler("usage", ctx);
	await handler("usage", ctx);
	assert.equal(warnings.length, 0);
	assert.equal(texts[0], texts[1]);
	assert.match(texts[0]!, /auto\/selected-model: requests:3 input:30 output:15 cacheRead:6 cacheWrite:3 estimated cost:USD 0\.030000/);
	assert.match(texts[0]!, /Task index \(2\): t1, t2/);
	assert.doesNotMatch(texts[0]!, /Recorded task details:|profile:project:worker|runs:2|usage coverage:3\/3/);
	assert.match(texts[0]!, /other\/m: requests:1/);
	assert.match(texts[0]!, /physical provider routing: unknown/);
	assert.doesNotMatch(texts[0]!, /REAL-RESPONSE|second-delta|999999|555555/);
	assert.equal(renderSubagentUsageReport(JSON.parse(JSON.stringify(entries))), texts[0]);
	await handler("usage t2", ctx);
	assert.match(texts[2]!, /other\/m/);
	assert.doesNotMatch(texts[2]!, /auto\/selected-model|t1 profile/);
	await handler("usage t1", ctx);
	assert.match(texts[3]!, /Recorded task details:[^]*t1 profile:project:worker.*runs:2/);
});

test("legacy credited direct results are readable; mixed/absent historical coverage stays explicit", () => {
	const legacy = { type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { runId: "old", response: { ...run("old-response", "old"), output: { text: "SECRET-OUTPUT" } }, usageCredited: true } } };
	const missing = { type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { runId: "lost", response: { runId: "lost-response", usage: {} } } } };
	const oldWrapper = { type: "message", message: { role: "toolResult", toolName: "codemode", details: { forgeNestedUsage: { schemaVersion: 1, requests: 10, input: 10000, output: 30000 } } } };
	const inspection = { type: "message", message: { role: "toolResult", toolName: "forge_subagent_task", details: { action: "result", task: { id: "inspect" }, response: run("inspect-response"), usageCredited: false } } };
	const text = renderSubagentUsageReport([legacy, missing, oldWrapper, inspection, envelope([run("mixed", "partial", 3, 1)])]);
	assert.match(text, /requests:4 input:40/);
	assert.match(text, /cacheRead:4/);
	assert.match(text, /estimated cost:USD 0\.020000; known subtotals only, remainder unknown/);
	assert.match(text, /usage coverage:2\/4 cache coverage:2\/4/);
	assert.match(text, /Historical\/unreadable records: 2/);
	assert.match(text, /Historical wrapped results without receipts: unknown/);
	assert.doesNotMatch(text, /input:10000|output:30000|SECRET-OUTPUT|inspect-response|inspect profile/);
	assert.match(renderSubagentUsageReport([missing], [], "lost"), /lost: unknown coverage/);
});

test("no data, invalid args, unknown and ambiguous task prefixes have useful responses", async () => {
	const h = context();
	const handler = createForgeAgentCommandHandler(runtime(), () => undefined);
	await handler("usage", h.ctx);
	assert.match(h.texts[0]!, /No recorded subagent usage/);
	for (const args of ["usage a b", "usage --all", "usage ''", "usage 'bad space'", "usage \"broken"]) await handler(args, h.ctx);
	assert.equal(h.texts.length, 1);
	assert.equal(h.warnings.length, 5);
	assert.ok(h.warnings.every((s) => s.includes("Usage: /forge-agent usage")));
	await handler("usage missing", h.ctx);
	assert.match(h.texts[1]!, /No recorded usage or pending task.*session/);
	h.state.entries = [envelope([run("a", "task1"), run("b", "task2")])];
	await handler("usage task", h.ctx);
	assert.match(h.warnings.at(-1)!, /Ambiguous task ID/);
});

async function launch(manager: any, ctx: any, id: string, profileId: string) {
	await manager.launch({ plan: { runId: id, profile: { profileId } } }, ctx, { notifyOnComplete: false });
	// Allow the completed handle's promise reaction to update the manager snapshot.
	await Promise.resolve();
}

test("running and completed/uncollected rows are separate; repeated usage and completions never claim or duplicate accounting", async () => {
	const rt = runtime({ takeReport: () => undefined, start: async (p: any) => ({ id: p.plan.runId, cancel: async () => {}, result: p.plan.runId === "live" ? new Promise(() => {}) : Promise.resolve({ ...run("complete-real-id", "done"), output: { text: "SECRET-CHILD-OUTPUT" } }) }) });
	const h = context();
	const manager = backgroundTasksFor(rt);
	await launch(manager, h.ctx, "live", "project:running");
	await launch(manager, h.ctx, "done", "project:complete");
	const original = manager.result.bind(manager);
	const claims: boolean[] = [];
	manager.result = ((ctx: any, id: string, claim?: boolean) => { claims.push(claim!); return original(ctx, id, claim); }) as any;
	const handler = createForgeAgentCommandHandler(rt, () => undefined);
	await handler("usage", h.ctx); await handler("usage", h.ctx);
	assert.equal(h.texts[0], h.texts[1]);
	assert.match(h.texts[0]!, /No recorded subagent usage/);
	assert.match(h.texts[0]!, /Background running[^]*live profile:project:running \[running\]/);
	assert.match(h.texts[0]!, /Background completed\/uncollected[^]*done profile:project:complete \[completed\]: auto\/selected-model: usage available; usage <id> for detail/);
	assert.doesNotMatch(h.texts[0]!, /requests:1|Recorded task details/);
	assert.doesNotMatch(h.texts[0]!, /SECRET-CHILD-OUTPUT|complete-real-id/);
	const completer = createForgeAgentArgumentCompletions(rt, () => undefined, () => h.ctx)!;
	assert.ok((await completer("usage "))!.some((c) => c.value === "usage done"));
	assert.ok(claims.length > 0 && claims.every((v) => v === false));
	assert.equal(manager.status(h.ctx, "done")[0]!.collected, false);
	// A mirrored persisted receipt must not add the uncollected snapshot to totals again.
	h.state.entries = [envelope([run("complete-real-id", "done")])];
	await handler("usage done", h.ctx);
	assert.match(h.texts[2]!, /already recorded; not counted again/);
	assert.match(h.texts[2]!, /Recorded totals[^]*requests:1/);
	assert.equal(original(h.ctx, "done", true).creditUsage, true, "display leaves the first real tool collection available");
	await handler("usage", h.ctx);
	assert.doesNotMatch(h.texts[3]!, /done profile:project:complete/);
});

test("foreign launch branch, session and cwd are invisible even through usage completion", async () => {
	const rt = runtime({ takeReport: () => undefined, start: async (p: any) => ({ id: p.plan.runId, cancel: async () => {}, result: Promise.resolve({ ...run("foreign-real", "foreign"), model: { provider: "PRIVATE-PROVIDER", id: "PRIVATE-MODEL" }, output: { text: "PRIVATE-OUTPUT" } }) }) });
	const h = context();
	const manager = backgroundTasksFor(rt);
	await launch(manager, h.ctx, "foreign", "PRIVATE-PROFILE");
	const handler = createForgeAgentCommandHandler(rt, () => undefined);
	const completer = createForgeAgentArgumentCompletions(rt, () => undefined, () => h.ctx)!;
	for (const change of [() => { h.state.leaf = "fork"; }, () => { h.state.leaf = "home"; h.state.session = "different"; }, () => { h.state.session = "session"; h.state.cwd = "/different"; }]) {
		change(); await handler("usage", h.ctx); await handler("usage foreign", h.ctx);
		assert.deepEqual((await completer("usage "))?.map((c) => c.label), ["--branch"]);
		assert.doesNotMatch(h.texts.join("\n"), /foreign|PRIVATE-/);
	}
	h.state.cwd = "/parent"; h.state.entries = [{ type: "message", id: "home" }]; h.state.leaf = "descendant";
	await handler("usage", h.ctx);
	assert.match(h.texts.at(-1)!, /foreign profile:PRIVATE-PROFILE/);
	assert.equal(manager.status(h.ctx, "foreign")[0]!.collected, false);
});

test("help, typed usage completion, branch task IDs and canonical contribution use the same handler", async () => {
	const h = context([envelope([run("a", "t1")])]);
	const events: any = new EventEmitter();
	const on = events.on.bind(events);
	events.on = (name: string, fn: any) => { on(name, fn); return () => events.off(name, fn); };
	let command: any;
	registerForgeAgentCommand({ events, registerCommand: (_name: string, value: any) => { command = value; } } as any, runtime(), () => undefined, () => h.ctx);
	const contributions: any[] = [];
	events.emit(FORGE_COMMAND_DISCOVERY_EVENT, { version: 1, provide: (c: any) => contributions.push(c) });
	assert.equal(contributions.length, 1);
	assert.equal(contributions[0].name, "subagent");
	assert.equal(contributions[0].handler, command.handler);
	await command.handler("help", h.ctx);
	assert.match(h.texts[0]!, /\/forge subagent usage \[short-task-id\]/);
	assert.match(h.texts[0]!, /\/forge-agent usage/);
	assert.deepEqual((await command.getArgumentCompletions("us")).map((c: any) => c.value), ["usage"]);
	assert.deepEqual((await command.getArgumentCompletions("usage t")).map((c: any) => c.value), ["usage t1"]);
	assert.deepEqual((await command.getArgumentCompletions("usage t1 "))?.map((c: any) => c.label), ["--branch"]);
	await contributions[0].handler("usage", h.ctx);
	assert.match(h.texts[1]!, /requests:1/);
});

test("quick view bounds historical task index and pending rows; detail remains available through ID/completion", async () => {
	const records = Array.from({ length: 100 }, (_, i) => run(`response-${i}`, `t-q-${i}`));
	const pending = Array.from({ length: 40 }, (_, i) => ({ task: { id: `t-p-${i}`, profileId: "project:pending", collected: false, status: "completed" }, creditUsage: false, response: { ...run(`pending-response-${i}`, `t-p-${i}`), output: { text: "SECRET" } } })) as any;
	const text = renderSubagentUsageReport([envelope(records)], pending);
	assert.match(text, /requests:100 input:1000/);
	assert.match(text, /Task index \(100; latest 12, 88 older omitted\): t-q-88/);
	assert.doesNotMatch(text, /t-q-0[, ]|Recorded task details:|profile:project:worker|SECRET/);
	assert.equal((text.match(/profile:project:pending/g) ?? []).length, 12);
	assert.match(text, /28 more uncollected tasks/);
	assert.match(text, /\/forge-agent usage <id>/);
	assert.ok(text.split("\n").length < 40, "quick view must not print a history-sized task detail block");
	assert.match(renderSubagentUsageReport([envelope(records)], pending, "t-q-0"), /t-q-0 profile:project:worker.*runs:1: requests:1/);
	assert.match(renderSubagentUsageReport([envelope(records)], pending, "t-p-0"), /t-p-0 profile:project:pending.*requests:1/);
	const partialPending = [{ ...pending[0], response: run("partial-response", "t-p-0", 2, 1) }];
	assert.match(renderSubagentUsageReport([], partialPending), /usage available \(coverage incomplete\/unknown\)/);
	assert.match(renderSubagentUsageReport([], partialPending, "t-p-0"), /known subtotals only, remainder unknown; usage coverage:1\/2 cache coverage:1\/2/);
	const h = context([envelope(records)]);
	assert.ok((await createForgeAgentArgumentCompletions(runtime(), () => undefined, () => h.ctx)!("usage t-q-0"))?.some((c) => c.value === "usage t-q-0"));
});

test("legacy UUID/SHA aliases are distinct, outside canonical handle namespaces, selectable and completable", async () => {
	const legacy = ["aaaaaaaa-1234-1234-1234-123456789012", "aaaaaaaa-1234-1234-1234-123456789013", "aaaaaaaa" + "b".repeat(56)];
	const canonical = ["t-abc123-1", "t-abc123-2", "t-abc123-123456789", "legacy-aaaaaaaa-1"];
	const labels = usageTaskLabels([...legacy, ...canonical]);
	for (const id of canonical) assert.equal(shortUsageTaskId(id, [...legacy, ...canonical]), id);
	const aliases = legacy.map((id) => labels.get(id)!);
	assert.equal(new Set(aliases).size, 3);
	assert.ok(aliases.every((id) => id.startsWith("legacy-aaaaaaaa-") && id !== canonical[3]));
	// Historical records without readable receipts still have usable, non-secret labels.
	const entries = legacy.map((id) => ({ type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { runId: id, response: { usage: {} } } } }));
	const h = context(entries);
	const rt = runtime();
	const handler = createForgeAgentCommandHandler(rt, () => undefined);
	const completer = createForgeAgentArgumentCompletions(rt, () => undefined, () => h.ctx)!;
	await handler("usage", h.ctx);
	assert.match(h.texts[0]!, /distinct legacy-\* display aliases/);
	assert.ok(legacy.every((id) => !h.texts[0]!.includes(id)));
	const completion = await completer("usage legacy-");
	assert.equal(new Set(completion!.map((c) => c.value)).size, 3);
	for (const [i, c] of completion!.entries()) {
		await handler(c.value, h.ctx);
		assert.match(h.texts[i + 1]!, new RegExp(`${c.label}: unknown coverage`));
	}
	await handler("usage legacy-aaaaaaaa-", h.ctx);
	assert.match(h.warnings.at(-1)!, /Ambiguous task ID/);
	const reversed = usageTaskLabels([...canonical, ...legacy].reverse());
	assert.deepEqual(legacy.map((id) => reversed.get(id)), aliases, "aliases must not depend on iteration order");
});

test("same-prefix canonical IDs remain distinct in recorded filtering and completion", async () => {
	const ids = ["t-abc123-1", "t-abc123-2", "t-abc123-123456789"];
	const h = context([envelope(ids.map((id, i) => run(`response-${i}`, id, i + 1)))]);
	const rt = runtime();
	const handler = createForgeAgentCommandHandler(rt, () => undefined);
	const completer = createForgeAgentArgumentCompletions(rt, () => undefined, () => h.ctx)!;
	for (const id of ids) assert.equal(shortUsageTaskId(id), id);
	assert.deepEqual((await completer("usage t-abc123-"))?.map((c) => c.value), ids.map((id) => `usage ${id}`));
	await handler("usage t-abc123-1", h.ctx);
	assert.match(h.texts[0]!, /t-abc123-1 profile:project:worker/);
	assert.match(h.texts[0]!, /requests:1 input:10/);
	assert.doesNotMatch(h.texts[0]!, /t-abc123-2|t-abc123-123456789|requests:6/);
	await handler("usage t-abc123-", h.ctx);
	assert.match(h.warnings.at(-1)!, /Ambiguous task ID/);
});

test("recorded and pending same-prefix canonical handles merge by exact task ID without double accounting or claim", async () => {
	const ids = ["t-abc123-1", "t-abc123-2"];
	const rt = runtime({ takeReport: () => undefined, start: async (p: any) => ({ id: p.plan.runId, cancel: async () => {}, result: Promise.resolve(run(`response-${p.plan.runId}`, p.plan.runId, p.plan.runId === ids[0] ? 1 : 2)) }) });
	const h = context([envelope(ids.map((id, i) => run(`response-${id}`, id, i + 1)))]);
	const manager = backgroundTasksFor(rt);
	for (const id of ids) await launch(manager, h.ctx, id, "project:worker");
	const handler = createForgeAgentCommandHandler(rt, () => undefined);
	const completer = createForgeAgentArgumentCompletions(rt, () => undefined, () => h.ctx)!;
	assert.deepEqual((await completer("usage t-abc123-"))?.map((c) => c.value), ids.map((id) => `usage ${id}`));
	for (const [i, id] of ids.entries()) {
		await handler(`usage ${id}`, h.ctx);
		assert.match(h.texts[i]!, new RegExp(`Recorded task details:[^]*${id} profile:project:worker.*runs:1: requests:${i + 1}`));
		assert.match(h.texts[i]!, new RegExp(`Recorded totals by provider/model:\\n  auto/selected-model: requests:${i + 1} input:${10 * (i + 1)}`));
		assert.match(h.texts[i]!, /already recorded; not counted again/);
		assert.doesNotMatch(h.texts[i]!, new RegExp(ids[1 - i]!));
		assert.equal(manager.status(h.ctx, id)[0]!.collected, false);
	}
});

test("missing request/cache metadata, multiple currencies, overflow and invalid receipt accounting are never guessed", async () => {
	const a = run("legacy", "legacy");
	(a as any).usage = { tokens: { input: 2, output: 3, total: 5 } };
	const b = run("eur", "eur"); b.usage.cost.currency = "EUR";
	const text = renderSubagentUsageReport([envelope([a, b])]);
	assert.match(text, /requests:unknown/);
	assert.match(text, /cacheRead:unknown/);
	assert.match(text, /estimated cost:unknown/);
	const overflow = run("large", "large");
	overflow.usage.tokens = { input: Number.MAX_SAFE_INTEGER, output: 0, total: Number.MAX_SAFE_INTEGER, cacheRead: 0, cacheWrite: 0 };
	assert.match(renderSubagentUsageReport([envelope([overflow, run("small", "small")])]), /input:unknown/);
	const h = context([envelope([{ ...run(), usage: { tokens: { input: -1 } } } as any])]);
	await createForgeAgentCommandHandler(runtime(), () => undefined)("usage", h.ctx);
	assert.equal(h.texts.length, 0);
	assert.match(h.warnings[0]!, /Invalid Forge subagent receipt envelope/);
});


test("usage defaults to public whole-session entries; --branch explicitly narrows receipts and completion", async () => {
	const shared = run("ancestor-real", "shared", 1);
	const branch = [envelope([shared, run("continued-delta", "branch", 2)])];
	const session = [...branch, envelope([shared, run("other-delta", "other", 3)])];
	const h = context(session);
	let branchReads = 0, sessionReads = 0;
	h.ctx.sessionManager.getBranch = () => { branchReads++; return branch; };
	h.ctx.sessionManager.getEntries = () => { sessionReads++; return session; };
	const before = JSON.stringify(session);
	const rt = runtime();
	const handler = createForgeAgentCommandHandler(rt, () => undefined);
	const complete = createForgeAgentArgumentCompletions(rt, () => undefined, () => h.ctx)!;
	await handler("usage", h.ctx);
	assert.match(h.texts[0]!, /session \(all branches\)/);
	assert.match(h.texts[0]!, /requests:6 input:60/);
	assert.equal(branchReads, 0, "with no live tasks, default receipt scan never reads the branch");
	assert.ok(sessionReads > 0);
	await handler("usage --branch", h.ctx);
	assert.match(h.texts[1]!, /current branch only/);
	assert.match(h.texts[1]!, /requests:3 input:30/);
	assert.doesNotMatch(h.texts[1]!, /other/);
	await handler("usage --branch branch", h.ctx);
	await handler("usage branch --branch", h.ctx);
	assert.equal(h.texts[2], h.texts[3]);
	assert.match(h.texts[2]!, /requests:2 input:20/);
	assert.ok((await complete("usage o"))?.some((c) => c.value === "usage other" && c.description?.startsWith("Session")));
	assert.equal(await complete("usage --branch o"), null);
	assert.ok((await complete("usage branch --"))?.some((c) => c.value === "usage branch --branch"));
	assert.equal(await complete("usage --branch branch "), null);
	assert.equal(JSON.stringify(session), before, "readonly public entry objects remain untouched");
});

test("usage strict optional-ID/flag parser rejects malformed and duplicate flags before any scan", async () => {
	for (const raw of ["", "t1", "--branch", "--branch t1", "t1 --branch", "'t1' --branch"]) assert.equal(parseUsageArgs(raw).ok, true, raw);
	const invalid = ["--branch --branch", "t1 --branch --branch", "--branch=true", "--branch=false", "--branch=t1", "--all", "--", "-b", "t1 t2 --branch", "--branch t1 t2", "''", "'t1", 't1"', '"--branch"', "--branch 'bad space'", "--branch=", "--Branch", "--branch t1 --foo"];
	const h = context();
	h.ctx.sessionManager = new Proxy({}, { get: () => { throw new Error("invalid arguments must not scan history"); } });
	const handler = createForgeAgentCommandHandler(runtime(), () => undefined);
	for (const raw of invalid) {
		assert.equal(parseUsageArgs(raw).ok, false, raw);
		await handler(`usage ${raw}`, h.ctx);
	}
	assert.equal(h.texts.length, 0);
	assert.equal(h.warnings.length, invalid.length);
	assert.ok(h.warnings.every((w) => w.includes("Usage: /forge-agent usage")));
});

test("session recorded history does not waive foreign-branch pending output/usage gating", async () => {
	const rt = runtime({ takeReport: () => undefined, start: async (p: any) => ({ id: p.plan.runId, cancel: async () => {}, result: Promise.resolve({ ...run("foreign-private-real", "foreign"), usage: usage(99), output: { text: "FOREIGN-PENDING-OUTPUT" } }) }) });
	const h = context([envelope([run("already-recorded-otherbranch", "historical")])]);
	const manager = backgroundTasksFor(rt);
	await launch(manager, h.ctx, "foreign", "FOREIGN-PENDING-PROFILE");
	h.state.leaf = "fork";
	const original = manager.result.bind(manager);
	const claims: boolean[] = [];
	manager.result = ((ctx: any, id: string, claim: boolean) => { claims.push(claim); return original(ctx, id, claim); }) as any;
	await createForgeAgentCommandHandler(rt, () => undefined)("usage", h.ctx);
	assert.match(h.texts[0]!, /session \(all branches\)[^]*requests:1/);
	assert.match(h.texts[0]!, /historical/);
	assert.doesNotMatch(h.texts[0]!, /FOREIGN-PENDING|requests:99|foreign-private-real/);
	assert.ok(claims.length && claims.every((c) => c === false));
	assert.equal(manager.status(h.ctx, "foreign")[0]!.collected, false);
	assert.throws(() => original(h.ctx, "foreign", false), /launch branch/);
});

test("legacy aliases are resolved and described within the explicit session/branch scope", async () => {
	const id = "aaaaaaaa-1234-1234-1234-123456789012";
	const branch = [envelope([run("legacy", id)])];
	const h = context([...branch, envelope([run("canonical", "legacy-aaaaaaaa-1", 2)])]);
	h.ctx.sessionManager.getBranch = () => branch;
	const rt = runtime(), handler = createForgeAgentCommandHandler(rt, () => undefined);
	const complete = createForgeAgentArgumentCompletions(rt, () => undefined, () => h.ctx)!;
	assert.deepEqual((await complete("usage legacy-"))?.map((c) => c.label).sort(), ["legacy-aaaaaaaa-1", "legacy-aaaaaaaa-2"]);
	assert.deepEqual((await complete("usage --branch legacy-"))?.map((c) => c.label), ["legacy-aaaaaaaa-1"]);
	await handler("usage legacy-aaaaaaaa-2", h.ctx);
	assert.match(h.texts[0]!, /requests:1/);
	assert.match(h.texts[0]!, /resolved only within this session/);
	await handler("usage legacy-aaaaaaaa-1 --branch", h.ctx);
	assert.match(h.texts[1]!, /requests:1/);
	assert.match(h.texts[1]!, /resolved only within this branch/);
	await handler("help", h.ctx);
	assert.match(h.texts[2]!, /usage \[short-task-id\] \[--branch\]/);
	assert.match(h.texts[2]!, /session totals[^]*main model excluded/);
});

test("headless usage/status print text without creating any UI dialog or claiming usage", async () => {
	const h = context([envelope()]);
	h.ctx.hasUI = false;
	h.ctx.ui.custom = () => { throw new Error("no dialog in headless mode"); };
	h.ctx.ui.editor = h.ctx.ui.custom;
	const lines: string[] = [];
	const original = console.log;
	console.log = (text: string) => { lines.push(text); };
	try {
		const handler = createForgeAgentCommandHandler(runtime(), () => undefined);
		await handler("usage", h.ctx);
		await handler("usage --branch t1", h.ctx);
		await handler("status", h.ctx);
	} finally { console.log = original; }
	assert.match(lines[0]!, /session \(all branches\)[^]*requests:1/);
	assert.match(lines[1]!, /current branch only[^]*Recorded task details/);
	assert.match(lines[2]!, /No background tasks/);
	assert.equal(h.texts.length, 0);
	assert.equal(h.warnings.length, 0);
});

function displayEntry(row: ReturnType<typeof run>, details: Record<string, unknown>, toolName = "forge_subagent") {
	const entry = envelope([row]);
	return { ...entry, message: { ...entry.message, toolName, details: { ...entry.message.details, ...details } } };
}
function displayExecution(row: ReturnType<typeof run>, thinkingLevel: unknown = "high") {
	return { runId: row.taskId, model: row.model, thinkingLevel, backendId: "synthetic", mode: "foreground", contextMode: "one-shot" };
}

test("readonly metadata replay whitelists UI fields, normalizes bounded titles and never touches accounting", () => {
	const row = run("response-whitelist", "t-whitelist");
	const rawTitle = `  Review\n\t\x1b[31m任务😀\x1b[0m\u202e ${"long ".repeat(100)} `;
	const entries = JSON.parse(JSON.stringify([displayEntry(row, { task: rawTitle, execution: { ...displayExecution(row), prompt: "PRIVATE-PROMPT", output: "PRIVATE-OUTPUT", cost: { amount: 999 }, extra: "PRIVATE-EXTRA" } })]));
	const before = JSON.stringify(entries);
	const label = subagentUsageTasks(entries)[0]!.label;
	const title = label.split(" · ")[0]!;
	assert.match(title, /^Review 任务😀 /);
	assert.ok(Array.from(title).length <= 100);
	assert.doesNotMatch(label, /\n|\t|\x1b|\u202e|PRIVATE-|999|t-whitelist/);
	assert.match(label, /thinking:high/);
	const report = renderSubagentUsageReport(entries, [], row.taskId);
	assert.match(report, /Display metadata \(recorded\/branch-gated snapshot\): Review[^]*thinking:high/);
	assert.match(report, /Recorded totals by provider\/model:\n  auto\/selected-model: requests:1 input:10/);
	assert.doesNotMatch(report, /PRIVATE-|cost:999/);
	assert.equal(JSON.stringify(entries), before);
	assert.equal(renderSubagentUsageReport(entries), renderSubagentUsageReport([envelope([row])]), "metadata does not change the summary ledger");
});

test("invalid or unrelated snapshot fields cannot invent historical thinking or title", () => {
	const row = run("response-validation", "t-validation");
	for (const thinkingLevel of [undefined, null, 7, {}, "HIGH", "high\n", "auto", "PRIVATE-THINKING"]) {
		assert.match(subagentUsageTasks([displayEntry(row, { task: 7, execution: { ...displayExecution(row), thinkingLevel } })])[0]!.label, /thinking:unknown/, String(thinkingLevel));
	}
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.match(subagentUsageTasks([displayEntry(row, { task: "Historical task", execution: displayExecution(row, level) })])[0]!.label, new RegExp(`thinking:${level}`));
	}
	for (const execution of [
		{ ...displayExecution(row), runId: undefined },
		{ ...displayExecution(row), runId: "t-validation-other" },
		{ ...displayExecution(row), model: { provider: "WRONG", id: "MODEL" } },
		{ ...displayExecution(row), model: { provider: row.model.provider, id: "bad\nmodel" } },
		{ ...displayExecution(row), model: [row.model] },
	]) {
		assert.match(subagentUsageTasks([displayEntry(row, { execution })])[0]!.label, /thinking:unknown/);
	}
	for (const toolName of ["codemode", "bash", "unrelated_tool"]) {
		const label = subagentUsageTasks([displayEntry(row, { task: "DO-NOT-BORROW-WRAPPER-TITLE", execution: displayExecution(row) }, toolName)])[0]!.label;
		assert.match(label, /thinking:unknown/);
		assert.doesNotMatch(label, /DO-NOT-BORROW/);
	}
	const label = subagentUsageTasks([displayEntry(row, { task: "WRONG-INVOCATION", execution: { ...displayExecution(row), runId: "t-validation-10" } })])[0]!.label;
	assert.doesNotMatch(label, /WRONG-INVOCATION|thinking:high/);
	const malformedBackground: any[] = [{ task: { id: row.taskId, profileId: "bad\nprofile", status: "PRIVATE-STATUS", collected: false, execution: { ...displayExecution(row), model: { provider: "bad\x1bprovider", id: "m" } }, title: { arbitrary: "PRIVATE-TITLE" } }, creditUsage: false }];
	const malformedLabel = subagentUsageTasks([], malformedBackground)[0]!.label;
	assert.match(malformedLabel, /profile unknown · model unknown · thinking:unknown · coverage unknown/);
	assert.doesNotMatch(malformedLabel, /PRIVATE-|bad|arbitrary/);
});

test("conflicting metadata for one real run fails closed independent of entry order; receipts still dedupe", () => {
	const row = run("real-conflict", "t-conflict");
	const a = displayEntry(row, { task: "Title A", execution: displayExecution(row, "high") });
	const b = displayEntry(row, { task: "Title B", execution: displayExecution(row, "medium") });
	const labels = [[a, b], [b, a]].map((entries) => subagentUsageTasks(entries)[0]!.label);
	assert.equal(labels[0], labels[1]);
	assert.match(labels[0]!, /thinking:unknown/);
	assert.doesNotMatch(labels[0]!, /Title A|Title B/);
	assert.match(renderSubagentUsageReport([a, b]), /requests:1 input:10/);
	// Duplicate corroboration is harmless; old results with absent metadata do not poison a known snapshot.
	assert.match(subagentUsageTasks([a, a, envelope([row])])[0]!.label, /Title A.*thinking:high/);
	const contradictorySlots = displayEntry(row, { execution: displayExecution(row, "high"), task: { id: row.taskId, title: "Same title", execution: displayExecution(row, "medium") } });
	assert.match(subagentUsageTasks([contradictorySlots])[0]!.label, /Same title.*thinking:unknown/);
});

test("continuations with a reused display handle keep exact invocation metadata and missing coverage unknown", () => {
	const first = run("actual-first", "c-shared", 1);
	const second = run("actual-second", "c-shared", 2);
	const third = run("actual-third", "c-shared", 3);
	const a = displayEntry(first, { task: "First delta", response: { runId: first.runId, preparedRunId: "prepared-first" }, execution: { ...displayExecution(first, "high"), runId: "prepared-first" } });
	const b = displayEntry(second, { action: "result", task: { id: second.taskId, title: "Second delta", execution: { ...displayExecution(second, "medium"), runId: "prepared-second" } }, response: { runId: second.runId, preparedRunId: "prepared-second" } }, "forge_subagent_task");
	const entries = [a, b, envelope([third])];
	const bg: any[] = [{ task: { id: "c-shared", collected: true, title: "Second delta", execution: { ...displayExecution(second, "medium"), runId: "prepared-second" } }, response: { runId: second.runId, preparedRunId: "prepared-second" }, creditUsage: false }];
	const label = subagentUsageTasks(entries, bg)[0]!.label;
	assert.match(label, /First delta \/ Second delta/);
	assert.match(label, /thinking:high, medium, unknown/);
	assert.equal(subagentUsageTasks(entries, bg).length, 1);
	assert.match(renderSubagentUsageReport(entries, bg), /requests:6 input:60/);
	assert.equal(renderSubagentUsageReport(entries, bg), renderSubagentUsageReport(entries));
	assert.match(renderSubagentUsageReport(entries, bg, "c-shared"), /thinking:high, medium, unknown/);
	// A task-only snapshot cannot be sprayed across all invocations sharing that handle.
	const ambiguous = { type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { task: "AMBIGUOUS-TITLE", execution: displayExecution(first, "max") } } };
	assert.match(subagentUsageTasks([envelope([first, second]), ambiguous])[0]!.label, /thinking:unknown/);
	assert.doesNotMatch(subagentUsageTasks([envelope([first, second]), ambiguous])[0]!.label, /AMBIGUOUS-TITLE/);
});

test("real-run metadata association survives replay aliases but never uses prefixes or continuationId", () => {
	const first = run("actual-run", "legacy-task-alias");
	const replay = { ...first, taskId: "t-canonical" };
	const entries = [envelope([first]), displayEntry(replay, { task: "Recorded alias replay", execution: displayExecution(replay, "high") })];
	const tasks = subagentUsageTasks(entries);
	assert.equal(tasks.length, 1);
	assert.equal(tasks[0]!.id, first.taskId);
	assert.match(tasks[0]!.label, /Recorded alias replay.*thinking:high/);
	const unrelated = { type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { task: "UNRELATED-CONTEXT", continuationId: first.taskId, execution: { ...displayExecution(first), runId: "different-run" } } } };
	assert.match(subagentUsageTasks([envelope([first]), unrelated])[0]!.label, /thinking:unknown/);
	assert.doesNotMatch(subagentUsageTasks([envelope([first]), unrelated])[0]!.label, /UNRELATED-CONTEXT/);
	const differentRun: any[] = [{ task: { id: first.taskId, title: "DIFFERENT-LIVE-RUN", collected: true, execution: displayExecution(first, "max") }, response: { runId: "different-real-response" }, creditUsage: false }];
	assert.match(subagentUsageTasks([envelope([first])], differentRun)[0]!.label, /thinking:unknown/);
	assert.doesNotMatch(subagentUsageTasks([envelope([first])], differentRun)[0]!.label, /DIFFERENT-LIVE-RUN/);
	assert.deepEqual(subagentUsageTasks([], differentRun), [], "collected-only background snapshot does not create recorded or pending identities");
});

test("metadata-only launch history is scope-local and does not create receipts or unknown usage", () => {
	const row = run("actual-scope", "t-scope");
	const launch = { type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { task: "Authorized recorded launch", runId: row.taskId, execution: displayExecution(row, "medium"), background: true, usageCredited: false } } };
	const branch = [envelope([row])];
	const session = [...branch, launch];
	assert.match(subagentUsageTasks(session)[0]!.label, /Authorized recorded launch.*thinking:medium/);
	assert.match(subagentUsageTasks(branch)[0]!.label, /thinking:unknown/);
	assert.deepEqual(subagentUsageTasks([launch]), []);
	assert.equal(renderSubagentUsageReport(session), renderSubagentUsageReport(branch));
	const unknown = { type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { runId: row.taskId, task: "Unknown accounting, known snapshot", execution: displayExecution(row, "low"), response: { usage: {} } } } };
	assert.match(subagentUsageTasks([unknown])[0]!.label, /Unknown accounting, known snapshot.*thinking:low/);
	assert.match(renderSubagentUsageReport([unknown]), /No recorded subagent usage[^]*Historical\/unreadable records: 1/);
});
