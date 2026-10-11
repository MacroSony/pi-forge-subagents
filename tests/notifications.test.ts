import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentResponse } from "../src/contract/index.ts";
import { loadForgeSubagentSettings, projectSubagentsConfigPath } from "../src/config/subagents.ts";
import { backgroundTasksFor } from "../src/runtime/background-tasks.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";
import { buildSubagentSettingsSchema, scopedConfigToContributionValues, writeScopedSubagentSettings } from "../src/ui-contribution/subagent-settings-contribution.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function response(id: string, status: AgentResponse["status"] = "completed"): AgentResponse {
	return { schemaVersion: 1, runId: id, requestId: "request", backendId: "pi-inprocess", model: { provider: "mock", id: "mock" },
		status, durationMs: 1, effectiveToolIds: [], artifacts: [], output: { text: "SECRET OUTPUT" },
		usage: { requests: { total: 1, cacheKnown: 1, usageKnown: 1 } } } as unknown as AgentResponse;
}
function prepared(id: string): ForgeSubagentPreparedRun {
	return { request: {}, preflight: {}, diagnostics: [], plan: {
		runId: id, profile: { profileId: "project:worker" }, backendId: "pi-inprocess", model: { provider: "mock", id: "mock" },
		thinkingLevel: "off", effectiveToolIds: [], systemPrompt: "SECRET PROMPT", messages: [],
		access: { level: "read-only", executionBoundary: "shared-user", mounts: [], process: false },
	} } as unknown as ForgeSubagentPreparedRun;
}
function fixture(t: any) {
	const root = mkdtempSync(join(tmpdir(), "forge-notify-"));
	const global = join(root, "global");
	const cwd = join(root, "project");
	mkdirSync(global); mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	const prior = process.env.PI_FORGE_GLOBAL_DIR;
	process.env.PI_FORGE_GLOBAL_DIR = global;
	t.after(() => { if (prior === undefined) delete process.env.PI_FORGE_GLOBAL_DIR; else process.env.PI_FORGE_GLOBAL_DIR = prior; rmSync(root, { recursive: true, force: true }); });
	const state = { trusted: true, idle: true, session: "parent", leaf: "launch", branch: [{ id: "launch" }] };
	const ctx = { cwd, isProjectTrusted: () => state.trusted, isIdle: () => state.idle, hasUI: false,
		sessionManager: { getSessionId: () => state.session, getLeafId: () => state.leaf, getBranch: () => state.branch },
		ui: { notify() {} }, modelRegistry: { getAll: () => [], getAvailable: () => [] },
	} as unknown as ExtensionContext;
	const config = (patch: Record<string, unknown> = {}) => writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({
		// Tests exercise the opt-in path; pass { notifyOnComplete: undefined } to omit the key (built-in default).
		allowAgentInvocationWithoutApproval: true, notifyOnComplete: true, profiles: { "project:worker": { enabled: true } }, ...patch,
	}));
	config();
	const runs = new Map<string, ReturnType<typeof deferred<AgentResponse>>>();
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => ["pi-inprocess"], descriptors: () => [], prepare: async () => ({ ok: false, diagnostics: [] }),
		discard: async () => {}, execute: async () => { throw new Error("No provider allowed"); }, dispose: async () => {},
		start: async (run) => {
			const result = deferred<AgentResponse>(); runs.set(run.plan.runId, result);
			return { id: run.plan.runId, result: result.promise, cancel: async () => { result.resolve(response(run.plan.runId, "cancelled")); } };
		},
	};
	const manager = backgroundTasksFor(runtime);
	let current: ExtensionContext | undefined = ctx;
	const sent: Array<{ message: any; options: any }> = [];
	const stop = manager.configureNotifications({ sendMessage: (message, options) => { sent.push({ message, options }); } }, () => current);
	t.after(() => { stop(); manager.clear(); });
	const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
	return { root, global, ctx, state, config, runs, runtime, manager, sent, stop, tick, setCurrent: (value: ExtensionContext | undefined) => { current = value; } };
}

test("human notification master: default false (opt-in), explicit invalid false+warning, trusted project precedence", (t) => {
	const f = fixture(t);
	f.config({ notifyOnComplete: undefined });
	assert.equal(loadForgeSubagentSettings(f.ctx).notifyOnComplete, false);
	writeFileSync(join(f.global, "subagents.json"), JSON.stringify({ notifyOnComplete: false }));
	assert.equal(loadForgeSubagentSettings(f.ctx).notifyOnComplete, false);
	f.config({ notifyOnComplete: true });
	assert.equal(loadForgeSubagentSettings(f.ctx).notifyOnComplete, true);
	f.state.trusted = false;
	assert.equal(loadForgeSubagentSettings(f.ctx).notifyOnComplete, false);
	f.state.trusted = true;
	for (const value of ["true", null, 1, {}, []]) {
		f.config({ notifyOnComplete: value });
		const settings = loadForgeSubagentSettings(f.ctx);
		assert.equal(settings.notifyOnComplete, false);
		assert.ok(settings.warnings.some((warning) => /project notifyOnComplete must be boolean; set to false/.test(warning)));
	}
	f.config({ notifyOnComplete: false });
	assert.equal(loadForgeSubagentSettings(f.ctx).notifyOnComplete, false);
	writeFileSync(join(f.global, "subagents.json"), JSON.stringify({ notifyOnComplete: "false" }));
	f.config();
	assert.ok(loadForgeSubagentSettings(f.ctx).warnings.some((warning) => /global notifyOnComplete must be boolean/.test(warning)));
});

test("notification settings UI exposes master only and preserves unrelated config", (t) => {
	const f = fixture(t);
	const schema = buildSubagentSettingsSchema("project", projectSubagentsConfigPath(f.ctx.cwd), [], {});
	assert.ok(schema.fields.find((field) => field.key === "notifyOnComplete"));
	assert.ok(!schema.fields.find((field) => field.key === "profiles")?.recordFields?.some((field) => field.key === "notifyOnComplete"));
	assert.equal(scopedConfigToContributionValues({}).notifyOnComplete, "inherit");
	assert.equal(scopedConfigToContributionValues({ notifyOnComplete: "invalid" }).notifyOnComplete, "disabled");
	f.config({ unrelated: { keep: true } });
	for (const [choice, expected] of [["enabled", true], ["disabled", false], ["inherit", undefined]] as const) {
		assert.equal(writeScopedSubagentSettings(f.ctx, "project", { notifyOnComplete: choice }, []).ok, true);
		const raw = JSON.parse(readFileSync(projectSubagentsConfigPath(f.ctx.cwd), "utf8"));
		assert.equal(raw.notifyOnComplete, expected); assert.deepEqual(raw.unrelated, { keep: true });
	}
	assert.equal(writeScopedSubagentSettings(f.ctx, "project", { notifyOnComplete: true }, []).ok, false);
	f.state.trusted = false;
	assert.equal(writeScopedSubagentSettings(f.ctx, "project", { notifyOnComplete: "enabled" }, []).ok, false);
});

test("terminal notifications coalesce, use CUSTOM message, wake idle once, and never collect usage", async (t) => {
	const f = fixture(t);
	await f.manager.launch(prepared("t-one"), f.ctx);
	await f.manager.launch(prepared("t-two"), f.ctx);
	f.runs.get("t-one")!.resolve(response("t-one"));
	f.runs.get("t-two")!.resolve(response("t-two", "timed-out"));
	await f.tick();
	assert.equal(f.sent.length, 1);
	assert.deepEqual(f.sent[0]!.options, { triggerTurn: true });
	const message = f.sent[0]!.message;
	assert.equal(message.customType, "forge-subagent-completion");
	assert.equal(message.display, true);
	assert.match(message.content, /t-one: completed; t-two: timed-out/);
	assert.match(message.content, /forge_subagent_task action result/);
	assert.doesNotMatch(JSON.stringify(message), /SECRET|usage|project:worker|forge-notify/);
	assert.equal(message.role, undefined);
	assert.equal(message.content, "Background subagent tasks finished: t-one: completed; t-two: timed-out. Call forge_subagent_task action result with each task id to collect the result.");
	assert.deepEqual(message.details, { tasks: [{ id: "t-one", status: "completed" }, { id: "t-two", status: "timed-out" }] });
	for (const id of ["t-one", "t-two"]) {
		assert.equal(f.manager.result(f.ctx, id, false).task.collected, false);
		assert.equal(f.manager.result(f.ctx, id, true).creditUsage, true);
		assert.equal(f.manager.result(f.ctx, id, true).creditUsage, false);
	}
	await f.tick(); assert.equal(f.sent.length, 1);
});

test("without the human opt-in a finished background task sends nothing (default behavior unchanged)", async (t) => {
	const f = fixture(t);
	f.config({ notifyOnComplete: undefined });
	await f.manager.launch(prepared("t-quiet"), f.ctx);
	f.runs.get("t-quiet")!.resolve(response("t-quiet"));
	await f.tick(); await f.tick();
	assert.equal(f.sent.length, 0);
	assert.equal(f.manager.status(f.ctx, "t-quiet")[0]!.status, "completed");
	assert.equal(f.manager.result(f.ctx, "t-quiet", true).creditUsage, true);
});

test("busy terminal notification steers once, failure error is never injected", async (t) => {
	const f = fixture(t); f.state.idle = false;
	await f.manager.launch(prepared("t-fail"), f.ctx);
	f.runs.get("t-fail")!.reject(new Error("SECRET error /secret/cwd"));
	await f.tick();
	assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0]!.options, { deliverAs: "steer" });
	assert.match(f.sent[0]!.message.content, /t-fail: failed/);
	assert.equal(f.sent[0]!.message.content, "Background subagent tasks finished: t-fail: failed. Call forge_subagent_task action result with each task id to collect the result.");
	assert.deepEqual(f.sent[0]!.message.details, { tasks: [{ id: "t-fail", status: "failed" }] });
	assert.doesNotMatch(f.sent[0]!.message.content, /SECRET|\/secret/);
});

test("human off AND per-run false dominate requests; later enable does not resurrect opted-out runs", async (t) => {
	const f = fixture(t);
	f.config({ notifyOnComplete: false });
	await f.manager.launch(prepared("t-master-off"), f.ctx, { notifyOnComplete: true });
	f.config();
	await f.manager.launch(prepared("t-run-off"), f.ctx, { notifyOnComplete: false });
	for (const id of ["t-master-off", "t-run-off"]) f.runs.get(id)!.resolve(response(id));
	await f.tick(); assert.equal(f.sent.length, 0);
	assert.equal(f.manager.result(f.ctx, "t-master-off", true).creditUsage, true);
});

test("delivery rechecks live parent session/cwd/branch and accepts descendants", async (t) => {
	for (const change of ["session", "cwd", "branch", "absent", "descendant"] as const) {
		const f = fixture(t);
		await f.manager.launch(prepared(`t-${change}`), f.ctx);
		f.runs.get(`t-${change}`)!.resolve(response(`t-${change}`));
		await Promise.resolve(); // terminal callback queues; delivery has not happened
		if (change === "session") f.state.session = "foreign";
		if (change === "cwd") f.setCurrent({ ...f.ctx, cwd: "/wrong-parent" });
		if (change === "branch") { f.state.leaf = "other"; f.state.branch = [{ id: "other" }]; }
		if (change === "absent") f.setCurrent(undefined);
		if (change === "descendant") { f.state.leaf = "child"; f.state.branch.push({ id: "child" }); }
		await f.tick(); assert.equal(f.sent.length, change === "descendant" ? 1 : 0, change);
		f.state.session = "parent"; f.state.leaf = "launch"; f.state.branch = [{ id: "launch" }]; f.setCurrent(f.ctx);
		await f.tick(); assert.equal(f.sent.length, change === "descendant" ? 1 : 0, "suppressed wakes never revive");
		assert.equal(f.manager.status(f.ctx)[0]!.status, "completed");
		f.stop(); f.manager.clear();
	}
});

test("delivery rechecks master, trust, profile and unattended authorization revocation", async (t) => {
	for (const change of ["master", "trust", "profile", "approval", "override", "cwd"] as const) {
		const f = fixture(t);
		const external = join(f.root, "external"); mkdirSync(external);
		f.config({ allowAgentModelOverrides: true, allowedWorkingDirectories: [external] });
		const run = prepared(`t-${change}`); if (change === "cwd") run.cwd = external;
		await f.manager.launch(run, f.ctx, { unattended: true, requiresModelOverridePermission: change === "override" });
		f.runs.get(`t-${change}`)!.resolve(response(`t-${change}`)); await Promise.resolve();
		if (change === "master") f.config({ notifyOnComplete: false });
		if (change === "trust") f.state.trusted = false;
		if (change === "profile") f.config({ profiles: { "project:worker": { enabled: false } } });
		if (change === "approval") f.config({ allowAgentInvocationWithoutApproval: false });
		if (change === "override") f.config({ allowAgentModelOverrides: false });
		if (change === "cwd") f.config({ allowedWorkingDirectories: [] });
		await f.tick(); assert.equal(f.sent.length, 0, change);
		f.state.trusted = true; f.config({ allowAgentModelOverrides: true, allowedWorkingDirectories: [external] });
		await f.tick(); assert.equal(f.sent.length, 0, "restoring grants does not revive suppressed wakes");
		f.stop(); f.manager.clear();
	}
});

test("cancel, clear, delivery disposal and prior result collection remove pending wakes", async (t) => {
	for (const action of ["cancel", "clear", "stop", "collect"] as const) {
		const f = fixture(t);
		await f.manager.launch(prepared(`t-${action}`), f.ctx);
		f.runs.get(`t-${action}`)!.resolve(response(`t-${action}`)); await Promise.resolve();
		if (action === "cancel") await f.manager.cancel(f.ctx, `t-${action}`);
		if (action === "clear") f.manager.clear();
		if (action === "stop") f.stop();
		if (action === "collect") f.manager.result(f.ctx, `t-${action}`, true);
		await f.tick(); assert.equal(f.sent.length, 0, action);
	}
	const f = fixture(t);
	await f.manager.launch(prepared("t-late"), f.ctx);
	f.manager.clear(); f.runs.get("t-late")!.resolve(response("t-late"));
	await f.tick(); assert.equal(f.sent.length, 0); assert.deepEqual(f.manager.status(f.ctx), []);
});

test("registered tool passes per-run opt-out; foreground never queues notifications", async (t) => {
	const f = fixture(t);
	let id = 0, tool: any;
	f.runtime.prepare = async () => ({ ok: true, prepared: prepared(`t-tool${++id}`) });
	f.runtime.execute = async (run) => response(run.plan.runId);
	registerForgeSubagentTool({ registerTool: (value: any) => { tool = value; } } as any, f.runtime, { sessionProvider: () => ({}) as any });
	assert.equal(tool.parameters.properties.notifyOnComplete.type, "boolean");
	const params = { profileId: "project:worker", task: "SECRET TASK" };
	const foreground = await tool.execute("call", { ...params, notifyOnComplete: true }, undefined, undefined, f.ctx);
	assert.equal(foreground.details.status, "completed");
	const off = await tool.execute("call", { ...params, background: true, notifyOnComplete: false }, undefined, undefined, f.ctx);
	const on = await tool.execute("call", { ...params, background: true }, undefined, undefined, f.ctx);
	assert.equal(off.details.background, true); assert.equal(on.details.background, true);
	assert.equal(off.usage, undefined); assert.equal(on.usage, undefined);
	f.runs.get(off.details.runId)!.resolve(response(off.details.runId));
	f.runs.get(on.details.runId)!.resolve(response(on.details.runId));
	await f.tick(); assert.equal(f.sent.length, 1);
	assert.match(f.sent[0]!.message.content, new RegExp(on.details.runId));
	assert.ok(!f.sent[0]!.message.content.includes(off.details.runId));
	assert.equal(f.manager.result(f.ctx, on.details.runId, true).creditUsage, true);
});

test("long or unsafe task identifiers never enter a notification", async (t) => {
	const f = fixture(t);
	for (const id of ["x".repeat(64), "task\nSECRET injected instruction"]) {
		await f.manager.launch(prepared(id), f.ctx); f.runs.get(id)!.resolve(response(id));
	}
	await f.tick(); assert.equal(f.sent.length, 0);
});
