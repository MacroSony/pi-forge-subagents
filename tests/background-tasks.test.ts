import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentResponse } from "../src/contract/index.ts";
import {
	backgroundTasksFor,
	ForgeBackgroundTasks,
} from "../src/runtime/background-tasks.ts";
import type {
	ForgeSubagentPreparedRun,
	ForgeSubagentRunHandle,
	ForgeSubagentRuntime,
} from "../src/runtime/subagent-runtime.ts";

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve: (val: T) => void;
	reject: (err: unknown) => void;
} {
	let resolve!: (val: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createDummyPrepared(
	id = "run-1",
	overrides: Partial<ForgeSubagentPreparedRun> = {},
): ForgeSubagentPreparedRun {
	return {
		request: {
			schemaVersion: 1,
			profile: { profileId: "worker" },
			task: { text: "task text" },
			access: { level: "read-only", network: "deny", allowProcess: false },
			depth: 1,
			traceId: `trace-${id}`,
			parentSessionId: "session-1",
		} as any,
		preflight: {} as any,
		plan: {
			schemaVersion: 1,
			runId: id,
			requestId: `req-${id}`,
			preflightId: `pre-${id}`,
			profile: {
				profileId: "project:worker",
				profile: { id: "worker", thinkingLevel: "high" } as any,
				promptStackId: "stack-1",
			} as any,
			backendId: "pi-inprocess",
			model: { provider: "test", id: "model-1" },
			thinkingLevel: "high",
			effectiveToolIds: ["tool.read"],
			systemPrompt: "sys prompt",
			messages: [],
			conversationFingerprint:
				"sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
			executionFingerprint:
				"sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
			access: {
				level: "read-write",
				executionBoundary: "shared-user",
				mounts: [],
				process: false,
			} as any,
		} as any,
		diagnostics: [],
		cwd: "/test/target/workspace",
		...overrides,
	};
}

function createDummyContext(
	options: {
		sessionId?: string;
		cwd?: string;
		leafId?: string | null;
		branch?: Array<{ id: string }>;
	} = {},
): ExtensionContext {
	const sessionId = options.sessionId ?? "session-1";
	const cwd = options.cwd ?? "/test/parent/workspace";
	const leafId = options.leafId !== undefined ? options.leafId : "leaf-1";
	const branch = options.branch ?? (leafId ? [{ id: leafId }] : []);

	return {
		cwd,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => leafId,
			getBranch: () => branch,
		},
		signal: undefined,
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			find: () => undefined,
			hasConfiguredAuth: () => false,
		} as any,
	} as unknown as ExtensionContext;
}

function createCompletedResponse(runId: string): AgentResponse {
	return {
		schemaVersion: 1,
		requestId: `req-${runId}`,
		runId,
		backendId: "pi-inprocess",
		model: { provider: "test", id: "model-1" },
		status: "completed",
		durationMs: 15,
		effectiveToolIds: ["tool.read"],
		artifacts: [],
		output: { text: `Success output for ${runId}` },
		usage: { requests: { total: 1, cacheKnown: 1, usageKnown: 1 } },
	} as unknown as AgentResponse;
}

function createInertRuntime(
	startFn?: (
		prepared: ForgeSubagentPreparedRun,
		ctx: ExtensionContext,
	) => Promise<ForgeSubagentRunHandle>,
): ForgeSubagentRuntime {
	return {
		backendIds: () => ["pi-inprocess"],
		descriptors: () => [] as any,
		prepare: async () => ({ ok: false as const, diagnostics: [] }),
		discard: async () => undefined,
		start:
			startFn ??
			(async (prep) => ({
				id: prep.plan.runId,
				result: Promise.resolve(createCompletedResponse(prep.plan.runId)),
				cancel: async () => undefined,
			})),
		execute: async () => {
			throw new Error("execute not used by background manager");
		},
		dispose: async () => undefined,
	};
}

test("background manager: launch twice rejects, and parallel launch calls with same runId reject race", async () => {
	const runtime = createInertRuntime();
	const manager = new ForgeBackgroundTasks(runtime);
	const ctx = createDummyContext();
	const prep = createDummyPrepared("run-dup-seq");

	// 1. Sequential launch of the same prepared run
	const status1 = await manager.launch(prep, ctx);
	assert.equal(status1.id, "run-dup-seq");
	assert.equal(status1.profileId, "project:worker");

	await assert.rejects(
		() => manager.launch(prep, ctx),
		/This prepared run was already launched/,
		"Sequential launch of the same prepared run must reject",
	);

	// 2. Parallel concurrent launch of the same prepared run
	let startCallCount = 0;
	const delayDeferred = createDeferred<void>();
	const raceRuntime = createInertRuntime(async (p) => {
		startCallCount++;
		await delayDeferred.promise;
		return {
			id: p.plan.runId,
			result: Promise.resolve(createCompletedResponse(p.plan.runId)),
			cancel: async () => undefined,
		};
	});
	const raceManager = new ForgeBackgroundTasks(raceRuntime);
	const prepRace = createDummyPrepared("run-dup-race");

	const pendingLaunches = Promise.allSettled([
		raceManager.launch(prepRace, ctx),
		raceManager.launch(prepRace, ctx),
	]);

	delayDeferred.resolve();
	const [res1, res2] = await pendingLaunches;

	// Exactly one launch must succeed, and the other must reject synchronously
	const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
	const rejected = [res1, res2].filter((r) => r.status === "rejected");
	assert.equal(fulfilled.length, 1, "Exactly one parallel launch must fulfill");
	assert.equal(rejected.length, 1, "Exactly one parallel launch must reject");
	assert.match(
		(rejected[0] as PromiseRejectedResult).reason.message,
		/This prepared run was already launched/,
	);
	assert.equal(
		startCallCount,
		1,
		"Underlying runtime.start must be invoked at most once",
	);
});

test("background manager: result claim twice and parallel claim guarantee exactly-once usage credit", async () => {
	const runtime = createInertRuntime();
	const manager = new ForgeBackgroundTasks(runtime);
	const ctx = createDummyContext();
	const prep = createDummyPrepared("run-usage-claim");

	await manager.launch(prep, ctx);

	// Wait a tick for handle.result to settle
	await new Promise((r) => setTimeout(r, 10));

	// First claim with default/true claimUsage: credits usage
	const firstClaim = manager.result(ctx, "run-usage-claim", true);
	assert.equal(firstClaim.task.status, "completed");
	assert.equal(firstClaim.creditUsage, true, "First claim must credit usage");
	assert.equal(firstClaim.task.collected, true);
	assert.ok(firstClaim.response?.usage);

	// Second claim with claimUsage=true: must NOT credit usage again
	const secondClaim = manager.result(ctx, "run-usage-claim", true);
	assert.equal(secondClaim.task.status, "completed");
	assert.equal(
		secondClaim.creditUsage,
		false,
		"Second claim must NOT credit usage",
	);
	assert.equal(secondClaim.task.collected, true);

	// Parallel simultaneous claims on another task
	const prepParallel = createDummyPrepared("run-usage-parallel");
	await manager.launch(prepParallel, ctx);
	await new Promise((r) => setTimeout(r, 10));

	const claimA = manager.result(ctx, "run-usage-parallel", true);
	const claimB = manager.result(ctx, "run-usage-parallel", true);

	const credits = [claimA.creditUsage, claimB.creditUsage].filter(Boolean);
	assert.equal(
		credits.length,
		1,
		"Exactly one parallel result claim must receive creditUsage = true",
	);

	// Inspection with claimUsage=false does NOT steal usage credit
	const prepInspect = createDummyPrepared("run-usage-inspect");
	await manager.launch(prepInspect, ctx);
	await new Promise((r) => setTimeout(r, 10));

	const inspectOnly = manager.result(ctx, "run-usage-inspect", false);
	assert.equal(
		inspectOnly.creditUsage,
		false,
		"claimUsage=false must not credit usage",
	);
	assert.equal(
		inspectOnly.task.collected,
		false,
		"claimUsage=false must leave collected=false",
	);

	const subsequentModelClaim = manager.result(ctx, "run-usage-inspect", true);
	assert.equal(
		subsequentModelClaim.creditUsage,
		true,
		"Subsequent claim after inspection must credit usage",
	);
	assert.equal(subsequentModelClaim.task.collected, true);
});

test("background manager: session mismatch and branch divergence denial", async () => {
	const runtime = createInertRuntime();
	const manager = new ForgeBackgroundTasks(runtime);

	const launchCtx = createDummyContext({
		sessionId: "session-alpha",
		cwd: "/workspace/parent",
		leafId: "leaf-origin",
		branch: [{ id: "root" }, { id: "leaf-origin" }],
	});

	const prep = createDummyPrepared("run-scope-test");
	await manager.launch(prep, launchCtx);
	await new Promise((r) => setTimeout(r, 10));

	// 1. Session mismatch
	const otherSessionCtx = createDummyContext({
		sessionId: "session-beta",
		cwd: "/workspace/parent",
		leafId: "leaf-origin",
	});
	assert.throws(
		() => manager.result(otherSessionCtx, "run-scope-test"),
		/Unknown background task in this parent session/,
	);
	assert.throws(
		() => manager.status(otherSessionCtx, "run-scope-test"),
		/Unknown background task in this parent session/,
	);
	assert.deepEqual(
		manager.status(otherSessionCtx),
		[],
		"status() must filter out tasks from different sessions",
	);
	await assert.rejects(
		() => manager.cancel(otherSessionCtx, "run-scope-test"),
		/Unknown background task in this parent session/,
	);

	// 2. Parent CWD mismatch
	const otherCwdCtx = createDummyContext({
		sessionId: "session-alpha",
		cwd: "/different/parent/dir",
		leafId: "leaf-origin",
	});
	assert.throws(
		() => manager.result(otherCwdCtx, "run-scope-test"),
		/Unknown background task in this parent session/,
	);

	// 3. Branch divergence denial
	// Exact same leaf: allowed
	const sameBranchRes = manager.result(launchCtx, "run-scope-test", false);
	assert.equal(sameBranchRes.task.id, "run-scope-test");

	// Descendant leaf (leaf-origin is in branch history): allowed
	const descendantCtx = createDummyContext({
		sessionId: "session-alpha",
		cwd: "/workspace/parent",
		leafId: "leaf-descendant",
		branch: [{ id: "root" }, { id: "leaf-origin" }, { id: "leaf-descendant" }],
	});
	const descendantRes = manager.result(descendantCtx, "run-scope-test", false);
	assert.equal(descendantRes.task.id, "run-scope-test");

	// Unrelated/divergent leaf (leaf-origin is NOT in branch history): denied
	const divergedCtx = createDummyContext({
		sessionId: "session-alpha",
		cwd: "/workspace/parent",
		leafId: "leaf-diverged",
		branch: [{ id: "root" }, { id: "leaf-fork-other" }, { id: "leaf-diverged" }],
	});
	assert.throws(
		() => manager.result(divergedCtx, "run-scope-test"),
		/Return to the launch branch \(or a descendant\) to collect this result/,
	);

	// Status and cancel remain accessible across branches within the same session
	const statusAcrossBranch = manager.status(divergedCtx, "run-scope-test");
	assert.equal(statusAcrossBranch.length, 1);
	assert.equal(statusAcrossBranch[0]?.id, "run-scope-test");
});

test("background manager: no usage pending when task is starting or running", async () => {
	const runDeferred = createDeferred<AgentResponse>();
	const startDeferred = createDeferred<void>();

	const runtime = createInertRuntime(async (p) => {
		await startDeferred.promise;
		return {
			id: p.plan.runId,
			result: runDeferred.promise,
			cancel: async () => undefined,
		};
	});

	const manager = new ForgeBackgroundTasks(runtime);
	const ctx = createDummyContext();
	const prep = createDummyPrepared("run-pending-test");

	// 1. While starting (awaiting runtime.start)
	const launchPromise = manager.launch(prep, ctx);

	// Immediate result while status is "starting"
	const startingResult = manager.result(ctx, "run-pending-test", true);
	assert.equal(startingResult.task.status, "starting");
	assert.equal(startingResult.creditUsage, false);
	assert.equal(
		startingResult.task.collected,
		false,
		"Pending task must not be marked collected",
	);
	assert.equal(startingResult.response, undefined);

	// Cancellation while starting must reject with retry guidance
	await assert.rejects(
		() => manager.cancel(ctx, "run-pending-test"),
		/Task is still starting; retry cancellation once the launch returns/,
	);

	// Let start() finish -> task transitions to "running"
	startDeferred.resolve();
	await launchPromise;

	// 2. While running (result promise not yet settled)
	const runningStatus = manager.status(ctx, "run-pending-test")[0];
	assert.equal(runningStatus?.status, "running");

	const runningResult = manager.result(ctx, "run-pending-test", true);
	assert.equal(runningResult.task.status, "running");
	assert.equal(runningResult.creditUsage, false);
	assert.equal(
		runningResult.task.collected,
		false,
		"Running task must not be marked collected",
	);
	assert.equal(runningResult.response, undefined);

	// Resolve task completion
	runDeferred.resolve(createCompletedResponse("run-pending-test"));
	await new Promise((r) => setTimeout(r, 10));

	// 3. Now that task has finished running, result collection claims usage
	const completedResult = manager.result(ctx, "run-pending-test", true);
	assert.equal(completedResult.task.status, "completed");
	assert.equal(completedResult.creditUsage, true);
	assert.equal(completedResult.task.collected, true);
	assert.ok(completedResult.response?.output);
});

test("background manager: limit enforcement, eviction of collected, and clear invalidates late callbacks", async () => {
	const resultDeferreds = new Map<
		string,
		{ resolve: (r: AgentResponse) => void; reject: (err: unknown) => void }
	>();

	let takeReportCalls: string[] = [];
	const runtime = createInertRuntime(async (p) => {
		const deferred = createDeferred<AgentResponse>();
		resultDeferreds.set(p.plan.runId, deferred);
		return {
			id: p.plan.runId,
			result: deferred.promise,
			cancel: async () => undefined,
		};
	});
	(runtime as any).takeReport = (runId: string) => {
		takeReportCalls.push(runId);
	};

	// 1. Limit enforcement (limit = 2)
	const manager = new ForgeBackgroundTasks(runtime, 2);
	const ctx = createDummyContext();

	const prep1 = createDummyPrepared("task-1");
	const prep2 = createDummyPrepared("task-2");
	const prep3 = createDummyPrepared("task-3");

	await manager.launch(prep1, ctx);
	await manager.launch(prep2, ctx);

	// 3rd launch when limit=2 must fail while tasks are uncollected/running
	await assert.rejects(
		() => manager.launch(prep3, ctx),
		/Background task limit reached; collect completed results before starting more/,
	);

	// Finish and collect task-1
	resultDeferreds.get("task-1")!.resolve(createCompletedResponse("task-1"));
	await new Promise((r) => setTimeout(r, 10));

	const claim1 = manager.result(ctx, "task-1", true);
	assert.equal(claim1.task.collected, true);

	// Now 3rd launch must succeed by evicting collected task-1
	const status3 = await manager.launch(prep3, ctx);
	assert.equal(status3.id, "task-3");
	assert.throws(
		() => manager.status(ctx, "task-1"),
		/Unknown background task in this parent session/,
		"Evicted task-1 must no longer be present",
	);

	// 2. clear() invalidates active tasks and late callbacks do NOT resurrect state
	const task3Deferred = resultDeferreds.get("task-3")!;
	const lateDeferred = resultDeferreds.get("task-2")!;

	assert.equal(manager.status(ctx).length, 2); // task-2, task-3 (task-2 uncollected, task-3 running)

	// Call clear() to invalidate entire generation
	manager.clear();
	assert.equal(manager.status(ctx).length, 0);

	// Late resolution on cleared manager
	task3Deferred.resolve(createCompletedResponse("task-3"));
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(
		manager.status(ctx).length,
		0,
		"Late resolution must NOT resurrect task into cleared manager",
	);
	assert.ok(
		takeReportCalls.includes("task-3"),
		"takeReport must still be called to free process backend resources",
	);

	// Late rejection on cleared manager must not throw unhandled rejection or alter state
	lateDeferred.reject(new Error("Late failure"));
	await new Promise((r) => setTimeout(r, 10));

	assert.equal(
		manager.status(ctx).length,
		0,
		"Late rejection must NOT resurrect error into cleared manager",
	);

	// 3. clear() while runtime.start is in flight cancels handle and rejects launch
	let startCancelReason: string | undefined;
	const stuckStart = createDeferred<ForgeSubagentRunHandle>();
	const stuckRuntime = createInertRuntime(async () => stuckStart.promise);
	const raceClearManager = new ForgeBackgroundTasks(stuckRuntime);

	const launchPending = raceClearManager.launch(
		createDummyPrepared("stuck-task"),
		ctx,
	);

	// Clear while launch is awaiting runtime.start
	raceClearManager.clear();

	// Now unblock runtime.start
	stuckStart.resolve({
		id: "stuck-task",
		result: Promise.resolve(createCompletedResponse("stuck-task")),
		cancel: async (reason) => {
			startCancelReason = reason;
		},
	});

	await assert.rejects(
		launchPending,
		/Parent session changed during background start/,
	);
	assert.equal(startCancelReason, "Parent session changed during background start.");
});

test("background manager: singleton factory backgroundTasksFor", () => {
	const runtime = createInertRuntime();
	const managerA = backgroundTasksFor(runtime);
	const managerB = backgroundTasksFor(runtime);
	assert.equal(managerA, managerB, "backgroundTasksFor must return identical singleton for runtime");

	const otherRuntime = createInertRuntime();
	const managerOther = backgroundTasksFor(otherRuntime);
	assert.notEqual(managerA, managerOther, "Different runtimes must have isolated background task managers");
});
