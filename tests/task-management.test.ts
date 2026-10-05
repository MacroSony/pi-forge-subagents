import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentResponse } from "../src/contract/index.ts";
import { backgroundTasksFor, ForgeBackgroundTasks } from "../src/runtime/background-tasks.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRunHandle, ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import { registerForgeSubagentTaskTool } from "../src/tool/forge-subagent-task.ts";

function ctxFor(options: { sessionId?: string; cwd?: string; leafId?: string | null; branch?: Array<{ id: string }> } = {}): ExtensionContext {
	const leafId = options.leafId !== undefined ? options.leafId : "leaf-1";
	return {
		cwd: options.cwd ?? "/parent",
		sessionManager: {
			getSessionId: () => options.sessionId ?? "session-1",
			getLeafId: () => leafId,
			getBranch: () => options.branch ?? (leafId ? [{ id: leafId }] : []),
		},
	} as unknown as ExtensionContext;
}

function prepared(id: string): ForgeSubagentPreparedRun {
	return {
		plan: { runId: id, profile: { profileId: "project:worker" }, backendId: "pi-inprocess", model: { provider: "p", id: "m" }, thinkingLevel: "high" },
		cwd: "/target", diagnostics: [],
	} as unknown as ForgeSubagentPreparedRun;
}

function response(runId: string, continuationId?: string): AgentResponse {
	return {
		schemaVersion: 1, requestId: `req-${runId}`, runId, backendId: "pi-inprocess", model: { provider: "p", id: "m" },
		status: "completed", durationMs: 1, effectiveToolIds: [], artifacts: [],
		output: { text: `SECRET-OUTPUT-${runId}` },
		usage: { requests: { total: 1, cacheKnown: 1, usageKnown: 1 } },
		...(continuationId ? { continuationId } : {}),
	} as unknown as AgentResponse;
}

interface Harness { runtime: ForgeSubagentRuntime; live: Map<string, string>; released: string[]; gates: Map<string, (r: AgentResponse) => void>; cancels: string[] }
function harness(retain: Record<string, string> = {}): Harness {
	const live = new Map<string, string>(); // continuation id -> owner session
	const released: string[] = [];
	const gates = new Map<string, (r: AgentResponse) => void>();
	const cancels: string[] = [];
	const runtime = {
		backendIds: () => ["pi-inprocess"], descriptors: () => [], prepare: async () => ({ ok: false, diagnostics: [] }), discard: async () => undefined,
		execute: async () => { throw new Error("unused"); }, dispose: async () => undefined,
		start: async (p: ForgeSubagentPreparedRun): Promise<ForgeSubagentRunHandle> => {
			const id = p.plan.runId;
			const cid = retain[id];
			if (cid) live.set(cid, "session-1");
			if (id.startsWith("run-")) {
				return { id, result: new Promise<AgentResponse>((resolve) => gates.set(id, resolve)), cancel: async () => { cancels.push(id); } };
			}
			return { id, result: Promise.resolve(response(id, cid)), cancel: async () => { cancels.push(id); } };
		},
		continuationInfo: (id: string, ctx: ExtensionContext) =>
			live.get(id) === ctx.sessionManager.getSessionId() ? { profileId: "project:worker", backendId: "pi-inprocess", cwd: "/target" } : undefined,
		releaseContinuation: async (id: string, ctx: ExtensionContext) => {
			if (!live.has(id)) throw new Error(`Unknown continuation handle: ${id}.`);
			if (live.get(id) !== ctx.sessionManager.getSessionId()) throw new Error("Continuation handles are private to their owning parent session.");
			live.delete(id); released.push(id);
		},
		listContinuations: (ctx: ExtensionContext) =>
			[...live].filter(([, owner]) => owner === ctx.sessionManager.getSessionId())
				.map(([id]) => ({ id, profileId: "project:worker", backendId: "pi-inprocess", cwd: "/target", model: { provider: "p", id: "m" }, thinkingLevel: "high", output: "LEAK" })),
	} as unknown as ForgeSubagentRuntime;
	return { runtime, live, released, gates, cancels };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test("status exposes continuationId only while the runtime confirms it alive, without output/usage", async () => {
	const h = harness({ t1: "c1", t2: "c2" });
	const m = new ForgeBackgroundTasks(h.runtime);
	const ctx = ctxFor();
	await m.launch(prepared("t1"), ctx);
	await m.launch(prepared("run-live"), ctx);
	await tick();
	const [t1, running] = m.status(ctx).filter((s) => s.id === "t1" || s.id === "run-live");
	assert.equal(t1!.continuationId, "c1");
	assert.equal(running!.continuationId, undefined);
	assert.doesNotMatch(JSON.stringify(m.status(ctx)), /SECRET|usage|output/);
	// Retained context continued/expired elsewhere: stale response id is not advertised.
	h.live.delete("c1");
	assert.equal(m.status(ctx, "t1")[0]!.continuationId, undefined);
	assert.equal(m.status(ctx, "t1")[0]!.collected, false);
});

test("contexts lists metadata for the current parent only and never claims a task", async () => {
	const h = harness({ t1: "c1" });
	const m = new ForgeBackgroundTasks(h.runtime);
	const ctx = ctxFor();
	await m.launch(prepared("t1"), ctx);
	await tick();
	h.live.set("other", "session-2");
	const listed = m.contexts(ctx);
	assert.deepEqual(listed, [{ id: "c1", profileId: "project:worker", backendId: "pi-inprocess", cwd: "/target", model: { provider: "p", id: "m" }, thinkingLevel: "high" }]);
	assert.doesNotMatch(JSON.stringify(listed), /LEAK|other/);
	assert.equal(m.status(ctx, "t1")[0]!.collected, false);
	assert.equal(m.result(ctx, "t1").creditUsage, true, "contexts must leave usage claimable");
	const legacy = new ForgeBackgroundTasks({ ...h.runtime, listContinuations: undefined } as ForgeSubagentRuntime);
	assert.throws(() => legacy.contexts(ctx), /updated runtime adapter/);
});

test("release by task id works from an unrelated branch, keeps result and usage claim, and is not repeatable", async () => {
	const h = harness({ t1: "c1" });
	const m = new ForgeBackgroundTasks(h.runtime);
	await m.launch(prepared("t1"), ctxFor());
	await tick();
	const fork = ctxFor({ leafId: "other-leaf" });
	assert.deepEqual(await m.release(fork, "t1"), { continuationId: "c1", taskId: "t1" });
	assert.deepEqual(h.released, ["c1"]);
	// Branch gate for result is unchanged.
	assert.throws(() => m.result(fork, "t1"), /launch branch/);
	const status = m.status(fork, "t1")[0]!;
	assert.equal(status.collected, false);
	assert.equal(status.continuationId, undefined);
	// Result still collectable once, usage credited exactly once.
	const home = ctxFor();
	const first = m.result(home, "t1");
	assert.equal(first.creditUsage, true);
	assert.match(first.response!.output!.text, /SECRET-OUTPUT-t1/);
	assert.equal(m.result(home, "t1").creditUsage, false);
	await assert.rejects(() => m.release(home, "t1"), /already released|expired/);
	await assert.rejects(() => m.release(home, "c1"), /Unknown continuation handle/);
	assert.deepEqual(h.released, ["c1"]);
});

test("release by continuation id delegates to runtime; unknown and foreign ids fail clearly", async () => {
	const h = harness({ t1: "c1" });
	const m = new ForgeBackgroundTasks(h.runtime);
	await m.launch(prepared("t1"), ctxFor());
	await tick();
	await assert.rejects(() => m.release(ctxFor(), "nope"), /Unknown continuation handle/);
	await assert.rejects(() => m.release(ctxFor({ sessionId: "session-2" }), "c1"), /private/);
	await assert.rejects(() => m.release(ctxFor({ sessionId: "session-2" }), "t1"), /Unknown continuation handle/, "foreign parent cannot use the task id");
	assert.deepEqual(await m.release(ctxFor(), "c1"), { continuationId: "c1" });
	assert.deepEqual(h.released, ["c1"]);
});

test("release by task id rejects starting/running tasks and does not cancel them", async () => {
	const h = harness();
	const m = new ForgeBackgroundTasks(h.runtime);
	const ctx = ctxFor();
	await m.launch(prepared("run-a"), ctx);
	await assert.rejects(() => m.release(ctx, "run-a"), /still running/);
	assert.deepEqual(h.cancels, []);
	assert.deepEqual(h.released, []);
	h.gates.get("run-a")!(response("run-a")); // terminal, nothing retained
	await tick();
	await assert.rejects(() => m.release(ctx, "run-a"), /no retained context/);
});

test("task whose context was continued by a later run: old task cannot release, live id can", async () => {
	const h = harness({ t1: "c1" });
	const m = new ForgeBackgroundTasks(h.runtime);
	const ctx = ctxFor();
	await m.launch(prepared("t1"), ctx);
	await tick();
	h.live.delete("c1"); h.live.set("c1b", "session-1"); // later run retained under a new handle
	await assert.rejects(() => m.release(ctx, "t1"), /already released|expired|continued/);
	assert.equal(m.contexts(ctx)[0]!.id, "c1b");
	assert.deepEqual(await m.release(ctx, "c1b"), { continuationId: "c1b" });
});

test("legacy runtime without continuationInfo keeps the response continuation id", async () => {
	const h = harness({ t1: "c1" });
	delete (h.runtime as { continuationInfo?: unknown }).continuationInfo;
	const m = new ForgeBackgroundTasks(h.runtime);
	await m.launch(prepared("t1"), ctxFor());
	await tick();
	assert.equal(m.status(ctxFor(), "t1")[0]!.continuationId, "c1");
	assert.deepEqual(await m.release(ctxFor(), "t1"), { continuationId: "c1", taskId: "t1" });
});

test("forge_subagent_task exposes contexts and task-id release without leaking output", async () => {
	const h = harness({ t1: "c1", t2: "c2" });
	const ctx = ctxFor();
	let tool: any;
	registerForgeSubagentTaskTool({ registerTool: (t: unknown) => { tool = t; } } as any, h.runtime, () => ({}) as any);
	// The tool resolves its manager through the runtime-keyed singleton.
	const shared = backgroundTasksFor(h.runtime);
	await shared.launch(prepared("t1"), ctx);
	await shared.launch(prepared("t2"), ctx);
	await tick();
	const call = (params: unknown) => tool.execute("id", params, undefined, undefined, ctx);

	const contexts = await call({ action: "contexts" });
	assert.equal(contexts.details.action, "contexts");
	assert.equal(contexts.details.contexts.length, 2);
	assert.match(contexts.content[0].text, /c1: project:worker p\/m thinking=high cwd=\/target/);
	assert.doesNotMatch(JSON.stringify(contexts), /LEAK|SECRET/);

	const status = await call({ action: "status", id: "t2" });
	assert.match(status.content[0].text, /\[retained: c2\]/);
	assert.doesNotMatch(JSON.stringify(status), /SECRET|"usage"/);
	const released = await call({ action: "release", id: "t2" });
	assert.equal(released.details.continuationId, "c2");
	assert.equal(released.details.taskId, "t2");
	assert.equal((await call({ action: "release", id: "t2" })).details.status, "failed");
	const direct = await call({ action: "release", id: "c1" });
	assert.equal(direct.details.continuationId, "c1");
	assert.equal((await call({ action: "release" })).details.status, "failed");
	assert.deepEqual(h.released, ["c2", "c1"]);
});
