import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";
import { registerForgeSubagentTaskTool } from "../src/tool/forge-subagent-task.ts";
import { backgroundTasksFor } from "../src/runtime/background-tasks.ts";
import { snapshotSubagentExecution } from "../src/ui/execution-display.ts";

process.env.PI_FORGE_GLOBAL_FORGE_DIR = join(tmpdir(), `forge-display-unused-global-${process.pid}`);
const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "forge-execution-display-"));
	mkdirSync(join(cwd, ".pi/forge"), { recursive: true });
	const config = (unattended = true) => writeFileSync(join(cwd, ".pi/forge/subagents.json"), JSON.stringify({ allowAgentInvocationWithoutApproval: unattended, allowAgentModelOverrides: true, profiles: { "project:worker": { enabled: true, backend: "pi-inprocess" } } }));
	config();
	let choice = "Approve and run"; let sequence = 0; let prepared: any; let behavior = "complete";
	let reportedModel: any; let finalStatus = "completed"; const completion = deferred<any>(); const executing = deferred<void>();
	const response = (p: any) => ({ schemaVersion: 1, requestId: `req-${p.plan.runId}`, runId: p.plan.runId, backendId: "pi-inprocess", model: reportedModel ?? p.plan.model, status: finalStatus, durationMs: 987, effectiveToolIds: ["read"], artifacts: [], output: { text: "CHILD-SECRET first\nsecond\nthird" }, usage: { requests: { total: 1, cacheKnown: 1, usageKnown: 1 } } });
	const runtime: any = {
		backendIds: () => ["pi-inprocess"], descriptors: () => [], dispose: async () => {}, discard: async () => {},
		continuationInfo: () => ({ profileId: "project:worker", backendId: "pi-inprocess", model: { provider: "retained", id: "child" }, thinkingLevel: "low" }),
		prepare: async (_profile: string, _task: string, _ctx: any, options: any) => {
			if (behavior === "prepare-failure") return { ok: false, diagnostics: [{ level: "error", code: "prepare.test", message: "unsupported requested model" }] };
			const model = options.model ?? (options.continueId ? { provider: "retained", id: "child" } : { provider: "sealed", id: "default" });
			const thinkingLevel = options.thinkingLevel ?? (options.continueId ? "low" : "high");
			prepared = {
				request: { input: { text: "PROMPT-SECRET" } }, cwd: "/target", continueId: options.continueId, keepContext: options.keepContext, diagnostics: [],
				plan: Object.freeze({ runId: `r${++sequence}`, backendId: "pi-inprocess", model: Object.freeze({ ...model }), thinkingLevel, profile: { profileId: "project:worker", profile: { model: { provider: "wrong", id: "profile" }, thinkingLevel: "off" } }, systemPrompt: "PROMPT-SECRET", messages: [], effectiveToolIds: ["read"], access: { level: "read-only", executionBoundary: "shared-user", mounts: [] }, executionFingerprint: "fp", conversationFingerprint: "cp" }),
			};
			return { ok: true, prepared };
		},
		execute: async (p: any) => { executing.resolve(); if (behavior === "execute-failure") throw new Error("execution failed after prepare"); if (behavior === "wait") return completion.promise; return response(p); },
		start: async (p: any) => { if (behavior === "start-failure") throw new Error("start failed after prepare"); return { id: p.plan.runId, result: completion.promise, cancel: async () => {} }; },
	};
	const ctx: any = { cwd, hasUI: true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s", getLeafId: () => "home", getBranch: () => [{ id: "home" }] }, ui: { select: async () => choice, editor: async () => undefined } };
	let tool: any; let management: any;
	registerForgeSubagentTool({ registerTool: (t: any) => { tool = t; } } as any, runtime, { sessionProvider: () => ({}) as any });
	registerForgeSubagentTaskTool({ registerTool: (t: any) => { management = t; } } as any, runtime, () => ({}) as any);
	const updates: any[] = [];
	return { cwd, runtime, ctx, tool, management, updates, completion, executing, config,
		setBehavior: (value: string) => { behavior = value; }, setChoice: (value: string) => { choice = value; }, setReported: (value: any) => { reportedModel = value; }, setFinalStatus: (value: string) => { finalStatus = value; },
		prepared: () => prepared, response: () => response(prepared),
		invoke: (params: any = {}) => tool.execute("call", { profileId: "worker", task: "PROMPT-SECRET", ...params }, undefined, (u: any) => updates.push(structuredClone(u)), ctx),
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

test("sealed plan defaults, explicit overrides, retained inheritance and context mode flow through tool updates/results", async () => {
	const f = fixture();
	try {
		for (const [params, model, thinking, contextMode] of [
			[{}, { provider: "sealed", id: "default" }, "high", "one-shot"],
			[{ model: "override/chosen", thinkingLevel: "off", keepContext: true }, { provider: "override", id: "chosen" }, "off", "retained"],
			[{ continueId: "c1" }, { provider: "retained", id: "child" }, "low", "continued"],
		] as any[]) {
			f.updates.length = 0;
			const result = await f.invoke(params);
			assert.equal(f.updates[0].details.execution, undefined, "preparing must not guess selection");
			for (const d of [...f.updates.slice(1).map((u) => u.details), result.details]) {
				assert.deepEqual(d.execution.model, model); assert.equal(d.execution.thinkingLevel, thinking);
				assert.equal(d.execution.contextMode, contextMode); assert.equal(d.execution.mode, "foreground");
				assert.equal(d.execution.cwd, "/target"); assert.equal(d.execution.backendId, "pi-inprocess");
				assert.equal(d.execution.runId, f.prepared().plan.runId);
				assert.doesNotMatch(JSON.stringify(d.execution), /PROMPT-SECRET|systemPrompt|profile|fingerprint|CHILD-SECRET/);
			}
			assert.equal(result.details.status, "completed");
			assert.notEqual(result.details.execution.model, f.prepared().plan.model);
			f.prepared().plan.profile.profile.thinkingLevel = "max";
			assert.equal(result.details.execution.thinkingLevel, thinking, "changed profile cannot relabel historical execution");
		}
	} finally { f.cleanup(); }
});

test("actual execute-in-flight fixture has selected metadata and no response, before any progress", async () => {
	const f = fixture();
	try {
		f.setBehavior("wait"); const pending = f.invoke(); await f.executing.promise;
		const running = f.updates.at(-1);
		assert.equal(running.details.status, "running"); assert.equal(running.details.response, undefined);
		const text = f.tool.renderResult(running, { expanded: false, isPartial: true }, theme).render(100).join("\n");
		assert.match(text, /sealed\/default/); assert.match(text, /thinking high/);
		f.completion.resolve(f.response()); await pending;
	} finally { f.cleanup(); }
});

test("preparation failure has no selected snapshot; rejection, foreground and background start failures preserve known snapshot", async () => {
	const f = fixture();
	try {
		f.setBehavior("prepare-failure"); const failedPrepare = await f.invoke({ model: "p/unsupported" });
		assert.equal(failedPrepare.details.execution, undefined); assert.equal(failedPrepare.details.approval.approved, false);
		f.setBehavior("complete"); f.config(false); f.setChoice("Reject");
		const rejected = await f.invoke(); assert.equal(rejected.details.status, "cancelled"); assert.equal(rejected.details.execution.thinkingLevel, "high"); assert.equal(rejected.details.approval.approved, false);
		f.config(); f.setBehavior("execute-failure");
		const failedRun = await f.invoke({ thinkingLevel: "low" }); assert.equal(failedRun.details.status, "failed"); assert.equal(failedRun.details.execution.thinkingLevel, "low"); assert.equal(failedRun.details.approval.approved, true);
		f.setBehavior("start-failure");
		const failedStart = await f.invoke({ background: true }); assert.equal(failedStart.details.status, "failed"); assert.equal(failedStart.details.execution.mode, "background"); assert.equal(failedStart.details.execution.thinkingLevel, "high");
	} finally { f.cleanup(); }
});

test("background launch/status/result preserve snapshot, branch gate and exactly-once collection without prompt/output in statuses", async () => {
	const f = fixture();
	try {
		const launch = await f.invoke({ background: true, keepContext: true, thinkingLevel: "off" });
		assert.match(launch.content[0].text, /Background subagent launched:.*Use forge_subagent_task/);
		const manager = backgroundTasksFor(f.runtime); const id = launch.details.runId;
		const initial = manager.status(f.ctx, id)[0]!;
		assert.deepEqual(initial.execution, launch.details.execution); assert.equal(initial.status, "running");
		initial.execution!.model.id = "tampered";
		assert.equal(manager.status(f.ctx, id)[0]!.execution!.model.id, "default", "public snapshot must not mutate internal task");
		const fork = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getLeafId: () => "fork", getBranch: () => [{ id: "fork" }] } };
		assert.doesNotMatch(JSON.stringify(manager.status(fork)), /PROMPT-SECRET|CHILD-SECRET|output|usage/);
		assert.equal(manager.status(fork, id)[0]!.execution!.thinkingLevel, "off");
		assert.throws(() => manager.result(fork, id, false), /launch branch/);
		assert.equal(manager.result(f.ctx, id, false).response, undefined);
		f.completion.resolve(f.response()); await Promise.resolve();
		assert.equal(manager.status(f.ctx, id)[0]!.status, "completed");
		assert.throws(() => manager.result(fork, id, false), /launch branch/);
		const inspect = manager.result(f.ctx, id, false); assert.equal(inspect.creditUsage, false); assert.equal(inspect.task.collected, false);
		const first = await f.management.execute("first", { action: "result", id }, undefined, undefined, f.ctx);
		assert.equal(first.details.usageCredited, true); assert.deepEqual(first.details.task.execution, launch.details.execution);
		const second = await f.management.execute("second", { action: "result", id }, undefined, undefined, f.ctx);
		assert.equal(second.details.usageCredited, false); assert.equal(second.usage, undefined); assert.equal(second.details.forgeNestedUsage, undefined);
		assert.equal(first.details.response.durationMs, 987);
		assert.doesNotMatch(JSON.stringify(manager.status(fork)), /PROMPT-SECRET|CHILD-SECRET|output|usage/);
	} finally { f.cleanup(); }
});

test("snapshot is an allowlisted copy; missing legacy model stays unknown", () => {
	const f = fixture();
	try {
		assert.equal(snapshotSubagentExecution({ plan: { runId: "legacy", profile: { profileId: "worker" } } } as any, "background"), undefined);
	} finally { f.cleanup(); }
});

test("terminal failed/cancelled/timed-out/limit response keeps selected thinking and distinguishes reported model", async () => {
	const f = fixture();
	try {
		f.setReported({ provider: "reported", id: "different" });
		for (const status of ["failed", "cancelled", "timed-out", "limit-reached"]) {
			f.setFinalStatus(status);
			const result = await f.invoke({ thinkingLevel: "max" });
			assert.equal(result.details.status, status);
			assert.deepEqual(result.details.execution.model, { provider: "sealed", id: "default" });
			assert.equal(result.details.execution.thinkingLevel, "max");
			const text = f.tool.renderResult(result, { expanded: false, isPartial: false }, theme).render(100).join("\n");
			assert.match(text, /selected sealed\/default/); assert.match(text, /reported reported\/different/); assert.match(text, /thinking max/);
		}
	} finally { f.cleanup(); }
});

test("approval dialog failure and background result rejection preserve known metadata without guessing usage", async () => {
	const f = fixture();
	try {
		f.config(false); f.ctx.ui.select = async () => { throw new Error("dialog failed"); };
		const approvalFailure = await f.invoke();
		assert.equal(approvalFailure.details.status, "failed"); assert.equal(approvalFailure.details.approval.approved, false);
		assert.equal(approvalFailure.details.execution.thinkingLevel, "high"); assert.equal(approvalFailure.usage, undefined);
		f.config();
		const launch = await f.invoke({ background: true, thinkingLevel: "minimal" });
		f.completion.reject(new Error("transport failed")); await Promise.resolve();
		const manager = backgroundTasksFor(f.runtime);
		const result = manager.result(f.ctx, launch.details.runId, false);
		assert.equal(result.task.status, "failed"); assert.equal(result.task.execution!.thinkingLevel, "minimal");
		assert.equal(result.response, undefined); assert.equal(result.creditUsage, false); assert.equal(result.task.collected, false);
	} finally { f.cleanup(); }
});

test("background short title is copied from request task only and returned solely on launch branch/descendants", async () => {
	const f = fixture();
	try {
		const originalPrepare = f.runtime.prepare;
		f.runtime.prepare = async (...args: any[]) => {
			const prepared = await originalPrepare(...args);
			prepared.prepared.request.input.text = "Review\n\u001b[31m\t代码 🧪 " + "bounded task text ".repeat(20);
			prepared.prepared.plan.profile.profile.title = "PROFILE-TITLE-SECRET";
			return prepared;
		};
		const launch = await f.invoke({ background: true });
		const manager = backgroundTasksFor(f.runtime); const id = launch.details.runId;
		const title = manager.status(f.ctx, id)[0]!.title;
		assert.ok(title?.startsWith("Review")); assert.ok(Array.from(title!).length <= 100); assert.doesNotMatch(title!, /[\x00-\x1f\x7f-\x9f]|PROFILE-TITLE|PROMPT-SECRET/);
		f.prepared().request.input.text = "MUTATED-TASK-SECRET";
		assert.equal(manager.status(f.ctx)[0]!.title, title);
		const descendant = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getLeafId: () => "descendant", getBranch: () => [{ id: "home" }, { id: "descendant" }] } };
		assert.equal(manager.status(descendant)[0]!.title, title);
		const fork = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getLeafId: () => "fork", getBranch: () => [{ id: "fork" }] } };
		for (const t of [...manager.status(fork), ...manager.status(fork, id)]) {
			assert.equal(Object.hasOwn(t, "title"), false); assert.equal(Object.hasOwn(t, "lastProgress"), false); assert.ok(t.execution?.model);
		}
		assert.equal(Object.hasOwn(await manager.cancel(fork, id), "title"), false);
		assert.throws(() => manager.result(fork, id, false), /launch branch/);
		const statusResult = await f.management.execute("status", { action: "status" }, undefined, undefined, f.ctx);
		assert.equal(statusResult.details.tasks[0].title, title);
		const displayed = f.management.renderResult(statusResult, { expanded: false, isPartial: false }, theme).render(180).join("\n");
		assert.ok(displayed.includes(title!));
		f.completion.resolve(f.response()); await Promise.resolve();
		assert.equal(Object.hasOwn(manager.status(fork)[0]!, "title"), false);
		assert.throws(() => manager.result(fork, id, false), /launch branch/);
		assert.equal(manager.result(descendant, id, false).task.title, title);
	} finally { f.cleanup(); }
});

test("unknown launch leaf omits title without changing legacy result access", async () => {
	const f = fixture();
	try {
		f.ctx.sessionManager.getLeafId = () => null; f.ctx.sessionManager.getBranch = () => [];
		const launch = await f.invoke({ background: true });
		const manager = backgroundTasksFor(f.runtime); const id = launch.details.runId;
		assert.equal(Object.hasOwn(manager.status(f.ctx, id)[0]!, "title"), false);
		const fork = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getLeafId: () => "fork" } };
		assert.equal(Object.hasOwn(manager.status(fork)[0]!, "title"), false);
		assert.equal(manager.result(fork, id, false).creditUsage, false);
		f.completion.resolve(f.response()); await Promise.resolve();
	} finally { f.cleanup(); }
});
