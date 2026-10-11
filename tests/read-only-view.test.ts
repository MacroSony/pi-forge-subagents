import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createForgeAgentCommandHandler } from "../src/command/forge-agent.ts";
import { backgroundTasksFor } from "../src/runtime/background-tasks.ts";
import { withSubagentDialog } from "../src/ui/dialog-gate.ts";
import { ReadOnlySubagentView, showReadOnlyView } from "../src/ui/read-only-view.ts";
import { subagentUsageTasks } from "../src/usage/report.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const execution = { model: { provider: "synthetic", id: "选择模型-long-model" }, thinkingLevel: "high", runId: "task-a", backendId: "test", mode: "background", contextMode: "one-shot" };
const receipt = { runId: "real-response", taskId: "task-a", profileId: "project:worker", model: execution.model, status: "completed", usage: { requests: { total: 1, cacheKnown: 1, usageKnown: 1 }, tokens: { input: 2, output: 3, total: 5, cacheRead: 0, cacheWrite: 0 } } };
const entries = [{ type: "message", message: { role: "toolResult", toolName: "codemode", details: { forgeSubagentUsage: { schemaVersion: 1, runs: [receipt] } } } }];
function harness() {
	let leaf = "launch";
	const edits: { title: string; text: string }[] = [], notifications: string[] = [];
	const ctx: any = {
		cwd: "/synthetic-parent", hasUI: true,
		sessionManager: { getSessionId: () => "synthetic-session", getLeafId: () => leaf, getEntries: () => entries, getBranch: () => [] },
		ui: { notify: (s: string) => notifications.push(s), editor: async (title: string, text: string) => { edits.push({ title, text }); return "IGNORED-EDIT"; } },
	};
	const forbidden = () => { throw new Error("read-only view must not execute, infer, collect, cancel or write"); };
	const runtime: any = {
		prepare: forbidden, execute: forbidden, discard: forbidden, takeReport: () => undefined,
		start: async (p: any) => ({ id: p.plan.runId, cancel: forbidden, result: Promise.resolve({ ...receipt, runId: `response-${p.plan.runId}`, durationMs: 1, backendId: "test", effectiveToolIds: [], output: { text: `AUTHORIZED-OUTPUT-${p.plan.runId}` } }) }),
	};
	const manager = backgroundTasksFor(runtime);
	const calls: boolean[] = [];
	const original = manager.result.bind(manager);
	manager.result = ((ctx: any, id: string, claim: boolean) => { calls.push(claim); return original(ctx, id, claim); }) as any;
	const launch = async (id = "task-a") => {
		await manager.launch({ plan: { ...execution, runId: id, profile: { profileId: "project:worker" } }, cwd: "/synthetic-target" } as any, ctx, { notifyOnComplete: false });
		await tick();
	};
	return { ctx, runtime, manager, calls, edits, notifications, launch, branch: () => { leaf = "other-branch"; } };
}
function custom(ctx: any, script: (view: ReadOnlySubagentView, done: () => void) => Promise<void>) {
	let calls = 0;
	ctx.ui.custom = async (factory: any) => {
		calls++;
		let finish!: () => void;
		const closed = new Promise<void>((resolve) => { finish = resolve; });
		const view = factory({ terminal: { rows: 60 }, requestRender: () => {} }, { fg: (_color: string, text: string) => text }, {}, finish);
		await script(view, finish);
		await closed;
		view.dispose?.();
	};
	return () => calls;
}

test("SDK custom usage summary → selection → detail → Esc is read-only and uses one dialog flow", async () => {
	const h = harness();
	await h.launch();
	// The mirrored receipt and live snapshot must represent the same invocation, not only the same display handle.
	h.ctx.sessionManager.getEntries = () => [{ ...entries[0], message: { ...entries[0]!.message, details: { forgeSubagentUsage: { schemaVersion: 1, runs: [{ ...receipt, runId: "response-task-a" }] } } } }];
	const count = custom(h.ctx, async (view) => {
		const summary = view.render(110).join("\n");
		assert.match(summary, /session \(all branches\)/);
		assert.match(summary, /project:worker.*synthetic\/选择模型-long-model.*thinking:high.*completed/);
		assert.doesNotMatch(summary, /AUTHORIZED-OUTPUT/);
		view.handleInput("\r");
		await tick();
		const detail = view.render(110).join("\n");
		assert.match(detail, /Recorded task details:[^]*requests:1/);
		assert.doesNotMatch(detail, /AUTHORIZED-OUTPUT/);
		view.handleInput("\x1b");
		assert.match(view.render(110).join("\n"), /Tasks \(Enter/);
		view.handleInput("\x1b");
	});
	await createForgeAgentCommandHandler(h.runtime, () => undefined)("usage", h.ctx);
	assert.equal(count(), 1);
	assert.equal(h.edits.length, 0, "real custom SDK never uses an editor");
	assert.equal(h.notifications.length, 0);
	assert.ok(h.calls.length > 0 && h.calls.every((claim) => claim === false));
	assert.equal(h.manager.status(h.ctx, "task-a")[0]!.collected, false);
});

test("no-ID custom status Enter displays gated output and selected metadata without claim", async () => {
	const h = harness();
	await h.launch();
	const count = custom(h.ctx, async (view) => {
		assert.match(view.render(110).join("\n"), /project:worker.*synthetic\/选择模型-long-model.*thinking:high.*completed/);
		assert.equal(h.calls.length, 0, "status listing does not peek at output/usage");
		view.handleInput("\r"); await tick();
		assert.match(view.render(110).join("\n"), /Thinking: high[^]*AUTHORIZED-OUTPUT-task-a/);
		view.handleInput("\x1b");
		assert.doesNotMatch(view.render(110).join("\n"), /AUTHORIZED-OUTPUT/);
		view.handleInput("\x1b");
	});
	await createForgeAgentCommandHandler(h.runtime, () => undefined)("status", h.ctx);
	assert.equal(count(), 1);
	assert.deepEqual(h.calls, [false]);
	assert.equal(h.manager.status(h.ctx, "task-a")[0]!.collected, false);
});

test("foreign-branch status selection may list permitted metadata but never bypasses result(false)", async () => {
	const h = harness(); await h.launch(); h.branch();
	custom(h.ctx, async (view) => {
		assert.doesNotMatch(view.render(110).join("\n"), /AUTHORIZED-OUTPUT/);
		view.handleInput("\r"); await tick();
		assert.match(view.render(110).join("\n"), /launch branch/);
		assert.doesNotMatch(view.render(110).join("\n"), /AUTHORIZED-OUTPUT|input:2|output:3/);
		view.handleInput("\x1b"); view.handleInput("\x1b");
	});
	await createForgeAgentCommandHandler(h.runtime, () => undefined)("status", h.ctx);
	assert.deepEqual(h.calls, [false]);
	assert.equal(h.manager.status(h.ctx, "task-a")[0]!.collected, false);
});

test("status selection cancellation has no result reads; old simulated contexts fall back with edits ignored", async () => {
	const h = harness(); await h.launch();
	let selections = 0;
	h.ctx.ui.select = async () => { selections++; return undefined; };
	await createForgeAgentCommandHandler(h.runtime, () => undefined)("status", h.ctx);
	assert.equal(selections, 1);
	assert.match(h.edits[0]!.title, /read-only; edits ignored/);
	assert.equal(h.calls.length, 0);
	assert.equal(h.manager.status(h.ctx, "task-a")[0]!.collected, false);
	const count = custom(h.ctx, async (view) => { view.handleInput("\x1b"); });
	await createForgeAgentCommandHandler(h.runtime, () => undefined)("status", h.ctx);
	assert.equal(count(), 1);
	assert.equal(h.calls.length, 0);
});

test("approval dialog active/queued: usage and status notify busy without stealing the custom slot", async () => {
	const h = harness();
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => { release = resolve; });
	const approval = withSubagentDialog(h.ctx.ui, () => waiting);
	const count = custom(h.ctx, async (view) => { view.handleInput("\x1b"); });
	const handler = createForgeAgentCommandHandler(h.runtime, () => undefined);
	await handler("usage", h.ctx); await handler("status", h.ctx);
	assert.equal(count(), 0);
	assert.equal(h.edits.length, 0);
	assert.equal(h.notifications.length, 2);
	assert.ok(h.notifications.every((s) => s.includes("active or queued")));
	release(); await approval;
	await handler("usage", h.ctx);
	assert.equal(count(), 1, "slot becomes usable after approval closes");
});

test("headless completed result stays plain text and leaves accounting unclaimed", async () => {
	const h = harness(); await h.launch(); h.ctx.hasUI = false;
	const count = custom(h.ctx, async (_view, done) => { done(); });
	const texts: string[] = [], log = console.log;
	console.log = (text: string) => texts.push(text);
	try { await createForgeAgentCommandHandler(h.runtime, () => undefined)("result task-a", h.ctx); }
	finally { console.log = log; }
	assert.equal(count(), 0);
	assert.equal(h.edits.length, 0);
	assert.match(texts[0]!, /AUTHORIZED-OUTPUT-task-a/);
	assert.deepEqual(h.calls, [false]);
	assert.equal(h.manager.status(h.ctx, "task-a")[0]!.collected, false);
});

test("component scroll, many tasks, CJK/emoji narrow widths, and pasted edits do not change data", async () => {
	const tasks = Array.from({ length: 80 }, (_, i) => ({ id: `task-${i}`, label: `任务😀 ${i} · ${"长模型".repeat(15)} · thinking:high · completed`, detail: () => `READONLY-${i}\n${"任务😀结果很长".repeat(150)}` }));
	let closed = 0;
	const view = new ReadOnlySubagentView({ title: "只读 summary", summary: "Overview\n".repeat(20), tasks }, () => 12, () => {}, () => { closed++; });
	view.handleInput("\x1b[B");
	for (const width of [1, 8, 20, 110]) {
		const lines = view.render(width);
		assert.ok(lines.length <= 12);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: ${JSON.stringify(lines)}`);
	}
	view.handleInput("PASTED-EDIT");
	view.handleInput("\r"); await tick();
	assert.match(view.render(110).join("\n"), /READONLY-1/);
	assert.doesNotMatch(view.render(110).join("\n"), /PASTED-EDIT/);
	view.handleInput("\x1b[6~");
	assert.doesNotMatch(view.render(110).join("\n"), /READONLY-1/);
	view.handleInput("\x1b"); view.handleInput("\x1b");
	assert.equal(closed, 1);
});

test("Esc/dispose while detail pending ignores late completion and does not reopen view", async () => {
	let resolve!: (text: string) => void;
	const detail = new Promise<string>((r) => { resolve = r; });
	let closed = 0;
	const view = new ReadOnlySubagentView({ title: "legacy", summary: "summary", tasks: [{ id: "old", label: "profile unknown · model unknown · thinking:unknown", detail: () => detail }] }, () => 20, () => {}, () => { closed++; });
	view.handleInput("\r"); await tick();
	view.handleInput("\x1b");
	assert.equal(closed, 0, "Esc cancels loading and returns to overview first");
	assert.doesNotMatch(view.render(80).join("\n"), /Loading|LATE-PRIVATE-DETAIL/);
	view.handleInput("\x1b"); view.dispose(); resolve("LATE-PRIVATE-DETAIL"); await tick();
	assert.equal(closed, 1);
	assert.deepEqual(view.render(80), [], "disposed view leaves no rendered residue");
});

test("legacy fallback canceled selection is readonly and does not evaluate detail", async () => {
	const h = harness();
	h.ctx.ui.select = async () => undefined;
	await showReadOnlyView(h.ctx, { title: "legacy", summary: "untouched", tasks: [{ id: "old", label: "unknown model/thinking", detail: () => { throw new Error("must not read canceled detail"); } }] });
	assert.equal(h.edits.length, 1);
	assert.match(h.edits[0]!.title, /read-only; edits ignored/);
	assert.equal(h.edits[0]!.text, "untouched");
});

test("duplicate status titles/profile/model/status select by index without persistent task handles", async () => {
	const h = harness();
	const ids = ["t-sameprefix-1", "t-sameprefix-2"];
	for (const id of ids) await h.launch(id);
	// Simulate the authorized optional public title projection while A adds its contract.
	const status = h.manager.status.bind(h.manager);
	h.manager.status = ((ctx: any, id?: string) => status(ctx, id).map((task) => ({ ...task, ...(ctx.sessionManager.getLeafId() === "launch" ? { title: "Repeated authorized title" } : {}) }))) as any;
	custom(h.ctx, async (view) => {
		const overview = view.render(160).join("\n");
		assert.match(overview, /1\. Repeated authorized title · project:worker/);
		assert.match(overview, /2\. Repeated authorized title · project:worker/);
		assert.ok(ids.every((id) => !overview.includes(id)), "opaque task handles appear only in detail");
		view.handleInput("\x1b[B"); view.handleInput("\r"); await tick();
		const detail = view.render(160).join("\n");
		assert.match(detail, /Task ID: t-sameprefix-2[^]*AUTHORIZED-OUTPUT-t-sameprefix-2/);
		assert.doesNotMatch(detail, /t-sameprefix-1/);
		view.handleInput("\x1b");
		assert.match(view.render(160).join("\n"), /› 2\. Repeated authorized title/);
		view.handleInput("\x1b");
	});
	const handler = createForgeAgentCommandHandler(h.runtime, () => undefined);
	await handler("status", h.ctx);
	assert.deepEqual(h.calls, [false]);
	h.branch();
	custom(h.ctx, async (view) => {
		const overview = view.render(160).join("\n");
		assert.match(overview, /1\. project:worker/);
		assert.doesNotMatch(overview, /Repeated authorized title|t-sameprefix/);
		view.handleInput("\x1b");
	});
	await handler("status", h.ctx);
});

test("usage task labels hide IDs/aliases, permit projected titles, and duplicate labels still choose the correct receipt", async () => {
	const ids = ["t-receipt-1", "t-receipt-2"];
	const records = [{ type: "message", message: { role: "toolResult", details: { forgeSubagentUsage: { schemaVersion: 1, runs: ids.map((taskId, index) => ({ ...receipt, taskId, runId: `real-${index}` })) } } } }];
	const tasks = subagentUsageTasks(records);
	assert.equal(tasks[0]!.label, tasks[1]!.label);
	assert.ok(tasks.every((task) => !task.label.includes("t-receipt")));
	const projected = subagentUsageTasks([], [{ task: { id: ids[0], profileId: "project:worker", title: "Authorized title", status: "running", collected: false, execution }, creditUsage: false }] as any);
	assert.match(projected[0]!.label, /^Authorized title · project:worker/);
	assert.doesNotMatch(projected[0]!.label, /t-receipt-1/);
	const legacy = subagentUsageTasks([{ type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { runId: "aaaaaaaa-1234-1234-1234-123456789012", response: { usage: {} } } } }]);
	assert.doesNotMatch(legacy[0]!.label, /aaaaaaaa|legacy-/);

	const h = harness();
	h.ctx.sessionManager.getEntries = () => records;
	custom(h.ctx, async (view) => {
		assert.doesNotMatch(view.render(140).join("\n"), /t-receipt/);
		view.handleInput("\x1b[B"); view.handleInput("\r"); await tick();
		const detail = view.render(140).join("\n");
		assert.match(detail, /session \(all branches\)[^]*t-receipt-2 profile:project:worker/);
		assert.doesNotMatch(detail, /t-receipt-1/);
		view.handleInput("\x1b"); view.handleInput("\x1b");
	});
	await createForgeAgentCommandHandler(h.runtime, () => undefined)("usage", h.ctx);
});

test("legacy select uses display ordinal rather than ID to distinguish identical labels", async () => {
	const h = harness();
	const visited: string[] = [];
	let selects = 0;
	h.ctx.ui.select = async (_title: string, options: string[]) => {
		selects++;
		assert.deepEqual(options, ["1. identical task · model/thinking unknown", "2. identical task · model/thinking unknown"]);
		assert.ok(options.every((label) => !label.includes("t-opaque")));
		return selects === 1 ? options[1] : undefined;
	};
	await showReadOnlyView(h.ctx, { title: "fallback", summary: "summary", tasks: ["t-opaque-1", "t-opaque-2"].map((id) => ({ id, label: "identical task · model/thinking unknown", detail: () => { visited.push(id); return `Task ID: ${id}`; } })) });
	assert.deepEqual(visited, ["t-opaque-2"]);
	assert.equal(selects, 2);
	assert.equal(h.edits[1]!.text, "Task ID: t-opaque-2");
});

test("custom usage summary retains costs/partial coverage and unreadable history warnings in both scopes", async () => {
	const partial = { ...receipt, usage: { ...receipt.usage, requests: { total: 3, usageKnown: 1, cacheKnown: 1 }, cost: { currency: "EUR", amount: 0.02 } } };
	const records = [
		{ type: "message", message: { role: "toolResult", details: { forgeSubagentUsage: { schemaVersion: 1, runs: [partial] } } } },
		{ type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { runId: "unknown-task", response: { usage: {} } } } },
	];
	const h = harness();
	h.ctx.sessionManager.getEntries = () => records;
	h.ctx.sessionManager.getBranch = () => records;
	const handler = createForgeAgentCommandHandler(h.runtime, () => undefined);
	for (const [args, scope] of [["usage", /session \(all branches\)/], ["usage --branch", /current branch only/]] as const) {
		custom(h.ctx, async (view) => {
			const summary = view.render(150).join("\n");
			assert.match(summary, scope);
			assert.match(summary, /estimated cost:EUR 0\.020000; known subtotals only, remainder unknown/);
			assert.match(summary, /usage coverage:1\/3 cache coverage:1\/3/);
			assert.match(summary, /Historical\/unreadable records: 1; requests\/input\/output\/cache\/estimated cost: unknown/);
			assert.doesNotMatch(summary, /Task index|unknown-task|task-a/);
			view.handleInput("\x1b");
		});
		await handler(args, h.ctx);
	}
});

test("height budget, resize, scrolling, detail Enter/Esc preserve selected overview position", async () => {
	let height = 10;
	const tasks = Array.from({ length: 25 }, (_, index) => ({ id: `t-hidden-${index}`, label: `same task ${index}`, detail: () => `Task ID: t-hidden-${index}\n${"detail content\n".repeat(40)}` }));
	const view = new ReadOnlySubagentView({ title: "session", summary: "summary\n".repeat(15), tasks }, () => height, () => {}, () => {});
	for (const h of [1, 2, 3, 4, 10, 22]) {
		height = h;
		for (const width of [1, 6, 35, 100]) {
			const lines = view.render(width);
			assert.ok(lines.length <= height, `${height} rows: ${lines.length}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
	height = 10;
	for (let i = 0; i < 20; i++) view.handleInput("\x1b[B");
	height = 1; assert.ok(view.render(80).length <= 1);
	height = 10;
	const overview = view.render(80).join("\n");
	assert.match(overview, /› 21\. same task 20/);
	view.handleInput("\r"); await tick();
	assert.match(view.render(80).join("\n"), /Task ID: t-hidden-20/);
	view.handleInput("\x1b[B");
	assert.doesNotMatch(view.render(80).join("\n"), /Task ID: t-hidden-20/);
	view.handleInput("\x1b[5~");
	assert.match(view.render(80).join("\n"), /Task ID: t-hidden-20/);
	view.handleInput("\x1b");
	assert.equal(view.render(80).join("\n"), overview, "Esc restores the selected overview viewport");
	view.handleInput("\x1b[5~");
	assert.doesNotMatch(view.render(80).join("\n"), /› 21\. same task 20/);
	view.handleInput("\x1b[B");
	assert.match(view.render(80).join("\n"), /› 22\. same task 21/);
});

test("immediate async detail cancellation skips deferred read; late rejection cannot affect a newer detail", async () => {
	let reads = 0, redraws = 0;
	let reject!: (error: Error) => void;
	const pending = new Promise<string>((_resolve, fail) => { reject = fail; });
	const view = new ReadOnlySubagentView({ title: "readonly", summary: "summary", tasks: [
		{ id: "t-first", label: "same task", detail: () => { reads++; return pending; } },
		{ id: "t-second", label: "same task", detail: () => "SECOND-DETAIL" },
	] }, () => 20, () => { redraws++; }, () => {});
	view.handleInput("\r"); view.handleInput("\x1b"); await tick();
	assert.equal(reads, 0, "canceled before deferred invocation: no detail read");
	view.handleInput("\r"); await tick(); assert.equal(reads, 1);
	view.handleInput("\x1b"); view.handleInput("\x1b[B"); view.handleInput("\r"); await tick();
	assert.match(view.render(80).join("\n"), /SECOND-DETAIL/);
	const before = redraws;
	reject(new Error("LATE-ERROR")); await tick();
	assert.equal(redraws, before, "stale detail never requests a redraw");
	assert.doesNotMatch(view.render(80).join("\n"), /LATE-ERROR|Loading/);
	assert.match(view.render(80).join("\n"), /SECOND-DETAIL/);
	view.dispose(); assert.deepEqual(view.render(80), []);
	view.handleInput("\r"); assert.equal(redraws, before, "disposed component ignores input");
});
