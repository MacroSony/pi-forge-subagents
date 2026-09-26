import assert from "node:assert/strict";
import test from "node:test";
import {
	createForgeAgentArgumentCompletions,
	createForgeAgentCommandHandler,
	parsePlanRunArgs,
	registerForgeAgentCommand,
} from "../src/command/forge-agent.ts";
import type { ForgeHostSession } from "../src/host/session.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";

function createDummyRuntime(overrides: Partial<ForgeSubagentRuntime> = {}): ForgeSubagentRuntime {
	return {
		backendIds: () => ["pi-subprocess-readonly", "pi-inprocess"],
		descriptors: () => [
			{
				id: "pi-subprocess-readonly",
				version: "v1",
				capabilities: {
					access: {
						readOnlyMountIsolation: true,
						readWriteMountIsolation: false,
						symlinkSafeContainment: true,
						processIsolation: false,
						agentNetworkIsolation: false,
					},
					executionBoundaries: ["shared-user"],
					promptRuntimeFidelity: "backend-assisted",
					cancellation: true,
					remoteTransport: false,
					limits: {} as any,
					mediaMimeTypes: [],
				},
			},
			{
				id: "pi-inprocess",
				version: "v1",
				capabilities: {
					access: {
						readOnlyMountIsolation: false,
						readWriteMountIsolation: true,
						symlinkSafeContainment: false,
						processIsolation: false,
						agentNetworkIsolation: false,
					},
					executionBoundaries: ["shared-user"],
					promptRuntimeFidelity: "backend-assisted",
					cancellation: true,
					remoteTransport: false,
					limits: {} as any,
					mediaMimeTypes: [],
				},
			},
		] as any,
		prepare: async () => ({ ok: false as const, diagnostics: [] }),
		discard: async () => undefined,
		execute: async () => { throw new Error("not executed"); },
		dispose: async () => undefined,
		...overrides,
	};
}

function createDummyPrepared(overrides: Partial<ForgeSubagentPreparedRun> = {}): ForgeSubagentPreparedRun {
	return {
		request: {
			schemaVersion: 1,
			profile: { profileId: "worker" },
			task: { text: "task" },
			access: { level: "read-only", network: "deny", allowProcess: false },
			depth: 1,
			traceId: "trace-1",
			parentSessionId: "s-1",
		} as any,
		preflight: {} as any,
		plan: {
			schemaVersion: 1,
			runId: "run-test-123",
			requestId: "req-1",
			preflightId: "pre-1",
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
			conversationFingerprint: "sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
			executionFingerprint: "sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
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

function createDummyContext(overrides: Record<string, any> = {}) {
	const notifications: Array<{ message: string; type: string }> = [];
	const editors: Array<{ title: string; text: string }> = [];
	const branch: Array<{ id: string }> = [];
	return {
		ctx: {
			cwd: "/test/parent/workspace",
			hasUI: true,
			isProjectTrusted: () => true,
			sessionManager: {
				getSessionId: () => "session-1",
				getLeafId: () => "leaf-1",
				getBranch: () => branch,
			},
			modelRegistry: {
				getAll: () => [],
				getAvailable: () => [],
				find: () => undefined,
				hasConfiguredAuth: () => false,
			},
			ui: {
				notify: (message: string, type: string) => { notifications.push({ message, type }); },
				setStatus: () => undefined,
				theme: { fg: (_c: string, text: string) => text },
				editor: async (title: string, text: string) => { editors.push({ title, text }); },
				select: async () => "Approve and run",
			},
			signal: undefined,
			...overrides,
		} as any,
		notifications,
		editors,
		branch,
	};
}

test("parsePlanRunArgs: parses --cwd with unquoted, double-quoted, and single-quoted paths", () => {
	const unquoted = parsePlanRunArgs("run", "worker --cwd /simple/path my task");
	assert.equal(unquoted.ok, true);
	if (unquoted.ok) {
		assert.equal(unquoted.cwd, "/simple/path");
		assert.equal(unquoted.profile, "worker");
		assert.equal(unquoted.task, "my task");
	}

	const doubleQuoted = parsePlanRunArgs("run", 'worker --cwd "/path with spaces/dir" my task');
	assert.equal(doubleQuoted.ok, true);
	if (doubleQuoted.ok) {
		assert.equal(doubleQuoted.cwd, "/path with spaces/dir");
		assert.equal(doubleQuoted.task, "my task");
	}

	const singleQuoted = parsePlanRunArgs("run", "worker --cwd '/path with spaces/dir' my task");
	assert.equal(singleQuoted.ok, true);
	if (singleQuoted.ok) {
		assert.equal(singleQuoted.cwd, "/path with spaces/dir");
		assert.equal(singleQuoted.task, "my task");
	}

	const equalQuoted = parsePlanRunArgs("run", 'worker --cwd="/path with spaces/dir" my task');
	assert.equal(equalQuoted.ok, true);
	if (equalQuoted.ok) {
		assert.equal(equalQuoted.cwd, "/path with spaces/dir");
		assert.equal(equalQuoted.task, "my task");
	}
});

test("parsePlanRunArgs: parses --keep-context and --continue (continuation implies keepContext)", () => {
	const keepOnly = parsePlanRunArgs("run", "worker --keep-context do work");
	assert.equal(keepOnly.ok, true);
	if (keepOnly.ok) {
		assert.equal(keepOnly.keepContext, true);
		assert.equal(keepOnly.continueId, undefined);
	}

	const contOnly = parsePlanRunArgs("run", "worker --continue cont-turn-1 do next step");
	assert.equal(contOnly.ok, true);
	if (contOnly.ok) {
		assert.equal(contOnly.continueId, "cont-turn-1");
		assert.equal(contOnly.keepContext, true, "continuation must imply keepContext true");
	}

	const contEqual = parsePlanRunArgs("run", "worker --continue=cont-turn-2 do next step");
	assert.equal(contEqual.ok, true);
	if (contEqual.ok) {
		assert.equal(contEqual.continueId, "cont-turn-2");
		assert.equal(contEqual.keepContext, true);
	}
});

test("parsePlanRunArgs: --background accepted on run, rejected on plan", () => {
	const runBg = parsePlanRunArgs("run", "worker --background do background task");
	assert.equal(runBg.ok, true);
	if (runBg.ok) {
		assert.equal(runBg.background, true);
		assert.equal(runBg.task, "do background task");
	}

	const planBg = parsePlanRunArgs("plan", "worker --background do background task");
	assert.equal(planBg.ok, false);
	if (!planBg.ok) {
		assert.match(planBg.error, /--background cannot be used with plan/);
	}
});

test("parsePlanRunArgs: options order before and after profile, preserves task quotes and whitespace", () => {
	const beforeProfile = parsePlanRunArgs("run", '--cwd "/tmp/test dir" worker exact task text');
	assert.equal(beforeProfile.ok, true);
	if (beforeProfile.ok) {
		assert.equal(beforeProfile.profile, "worker");
		assert.equal(beforeProfile.cwd, "/tmp/test dir");
		assert.equal(beforeProfile.task, "exact task text");
	}

	const taskText = 'echo "hello world" && ls -la';
	const preserved = parsePlanRunArgs("run", `worker --keep-context ${taskText}`);
	assert.equal(preserved.ok, true);
	if (preserved.ok) {
		assert.equal(preserved.task, taskText);
	}

	const withSentinel = parsePlanRunArgs("run", "worker --cwd /tmp -- echo --cwd /other --continue id");
	assert.equal(withSentinel.ok, true);
	if (withSentinel.ok) {
		assert.equal(withSentinel.cwd, "/tmp");
		assert.equal(withSentinel.task, "echo --cwd /other --continue id");
	}
});

test("parsePlanRunArgs: rejects flags inside task without '--' delimiter", () => {
	const inTaskCwd = parsePlanRunArgs("run", "worker run task --cwd /tmp");
	assert.equal(inTaskCwd.ok, false);
	assert.match((inTaskCwd as any).error, /--cwd must be specified before task/);

	const inTaskCont = parsePlanRunArgs("run", "worker run task --continue id");
	assert.equal(inTaskCont.ok, false);
	assert.match((inTaskCont as any).error, /--continue must be specified before task/);

	const inTaskKeep = parsePlanRunArgs("run", "worker run task --keep-context");
	assert.equal(inTaskKeep.ok, false);
	assert.match((inTaskKeep as any).error, /--keep-context must be specified before task/);

	const inTaskBg = parsePlanRunArgs("run", "worker run task --background");
	assert.equal(inTaskBg.ok, false);
	assert.match((inTaskBg as any).error, /--background must be specified before task/);
});

test("parsePlanRunArgs: rejects invalid or missing argument values", () => {
	const missingCwd = parsePlanRunArgs("run", "worker --cwd");
	assert.equal(missingCwd.ok, false);
	assert.match((missingCwd as any).error, /--cwd requires a path value/);

	const emptyCwd = parsePlanRunArgs("run", 'worker --cwd "" task');
	assert.equal(emptyCwd.ok, false);
	assert.match((emptyCwd as any).error, /--cwd requires a path value/);

	const missingCont = parsePlanRunArgs("run", "worker --continue");
	assert.equal(missingCont.ok, false);
	assert.match((missingCont as any).error, /--continue requires a continuation id value/);

	const emptyCont = parsePlanRunArgs("run", 'worker --continue="" task');
	assert.equal(emptyCont.ok, false);
	assert.match((emptyCont as any).error, /--continue requires a continuation id value/);
});

test("subcommand argument guards: status, result, cancel, release", async () => {
	const runtime = createDummyRuntime();
	const handler = createForgeAgentCommandHandler(runtime, () => undefined);

	// status: accepts 0 or 1 argument, rejects 2+
	const { ctx: statusCtx, notifications: statusWarns } = createDummyContext();
	await handler("status extra1 extra2", statusCtx);
	assert.ok(statusWarns.some((n) => n.type === "warning" && n.message.includes("accepts at most one task ID")));

	// result: requires exactly 1 argument
	const { ctx: resCtx0, notifications: resWarns0 } = createDummyContext();
	await handler("result", resCtx0);
	assert.ok(resWarns0.some((n) => n.type === "warning" && n.message.includes("Usage: /forge-agent result <id>")));

	const { ctx: resCtx2, notifications: resWarns2 } = createDummyContext();
	await handler("result id1 id2", resCtx2);
	assert.ok(resWarns2.some((n) => n.type === "warning" && n.message.includes("accepts exactly one task ID")));

	// cancel: requires exactly 1 argument
	const { ctx: cancelCtx0, notifications: cancelWarns0 } = createDummyContext();
	await handler("cancel", cancelCtx0);
	assert.ok(cancelWarns0.some((n) => n.type === "warning" && n.message.includes("Usage: /forge-agent cancel <id>")));

	const { ctx: cancelCtx2, notifications: cancelWarns2 } = createDummyContext();
	await handler("cancel id1 id2", cancelCtx2);
	assert.ok(cancelWarns2.some((n) => n.type === "warning" && n.message.includes("accepts exactly one task ID")));

	// release: requires exactly 1 argument
	const { ctx: relCtx0, notifications: relWarns0 } = createDummyContext();
	await handler("release", relCtx0);
	assert.ok(relWarns0.some((n) => n.type === "warning" && n.message.includes("Usage: /forge-agent release <continueId>")));

	const { ctx: relCtx2, notifications: relWarns2 } = createDummyContext();
	await handler("release id1 id2", relCtx2);
	assert.ok(relWarns2.some((n) => n.type === "warning" && n.message.includes("accepts exactly one continuation ID")));
});

test("plan: always passes unattended: false to runtime.prepare, shows target CWD, run ID, and continuation ID", async () => {
	let prepareOptions: any;
	const dummyPrepared = createDummyPrepared({
		cwd: "/approved/target/dir",
		continueId: "cont-prev-1",
		keepContext: true,
	});

	const runtime = createDummyRuntime({
		prepare: async (_profile, _task, _ctx, opts) => {
			prepareOptions = opts;
			return { ok: true as const, prepared: dummyPrepared };
		},
	});

	const session = {} as ForgeHostSession;
	const handler = createForgeAgentCommandHandler(runtime, () => session);
	const { ctx, editors } = createDummyContext();

	await handler('plan worker --cwd "/approved/target/dir" --continue cont-prev-1 my plan task', ctx);

	assert.ok(prepareOptions);
	assert.equal(prepareOptions.unattended, false, "CLI must always pass unattended: false for human verification");
	assert.equal(prepareOptions.cwd, "/approved/target/dir");
	assert.equal(prepareOptions.continueId, "cont-prev-1");
	assert.equal(prepareOptions.keepContext, true);

	assert.equal(editors.length, 1);
	const planText = editors[0]!.text;
	assert.match(planText, /Run ID: run-test-123/);
	assert.match(planText, /Target CWD: \/approved\/target\/dir/);
	assert.match(planText, /Continuation ID: cont-prev-1/);
	assert.match(planText, /Keep context: yes/);
});

test("run: interactive approval flow with target cwd and continuation", async () => {
	let executeCalled = false;
	const dummyPrepared = createDummyPrepared({
		cwd: "/approved/interactive/target",
	});

	const runtime = createDummyRuntime({
		prepare: async () => ({ ok: true as const, prepared: dummyPrepared }),
		execute: async () => {
			executeCalled = true;
			return {
				status: "completed",
				runId: "run-turn-2",
				backendId: "pi-inprocess",
				model: { provider: "test", id: "model-1" },
				durationMs: 120,
				effectiveToolIds: ["tool.read"],
				continuationId: "cont-next-turn",
				output: { text: "done turn 2" },
			} as any;
		},
	});

	const session = {} as ForgeHostSession;
	const handler = createForgeAgentCommandHandler(runtime, () => session);
	const { ctx, editors } = createDummyContext({
		ui: {
			notify: () => undefined,
			setStatus: () => undefined,
			theme: { fg: (_c: string, text: string) => text },
			editor: async (title: string, text: string) => { editors.push({ title, text }); },
			select: async () => "Approve and run",
		},
	});

	await handler('run worker --cwd "/approved/interactive/target" --keep-context run task', ctx);
	assert.equal(executeCalled, true);
	assert.equal(editors.length, 1);
	const resultText = editors[0]!.text;
	assert.match(resultText, /Run ID: run-turn-2/);
	assert.match(resultText, /Target CWD: \/approved\/interactive\/target/);
	assert.match(resultText, /Continuation ID: cont-next-turn/);
	assert.match(resultText, /Status: completed/);
});

test("run --background: launches via background manager after approval, no injected messages", async () => {
	let startCalled = false;
	const dummyPrepared = createDummyPrepared({
		cwd: "/target/background/dir",
	});

	const runtime = createDummyRuntime({
		prepare: async () => ({ ok: true as const, prepared: dummyPrepared }),
		start: async () => {
			startCalled = true;
			return {
				id: dummyPrepared.plan.runId,
				result: Promise.resolve({
					status: "completed",
					runId: dummyPrepared.plan.runId,
					backendId: "pi-inprocess",
					model: { provider: "test", id: "model-1" },
					durationMs: 250,
					effectiveToolIds: ["tool.read"],
					output: { text: "background result" },
				} as any),
				cancel: async () => undefined,
			};
		},
	});

	const session = {} as ForgeHostSession;
	const handler = createForgeAgentCommandHandler(runtime, () => session);
	const { ctx, editors } = createDummyContext();

	await handler('run worker --background --cwd "/target/background/dir" bg task', ctx);
	assert.equal(startCalled, true, "background launch must start the subagent task");
	assert.equal(editors.length, 1);
	const bgOutput = editors[0]!.text;
	assert.match(bgOutput, /Background task launched: run-test-123/);
	assert.match(bgOutput, /Run ID: run-test-123/);
	assert.match(bgOutput, /Target CWD: \/target\/background\/dir/);
	assert.match(bgOutput, /\/forge-agent status run-test-123/);
	assert.match(bgOutput, /\/forge-agent result run-test-123/);
	assert.match(bgOutput, /\/forge-agent cancel run-test-123/);

	// Status inspects the launched task
	editors.length = 0;
	await handler("status run-test-123", ctx);
	assert.equal(editors.length, 1);
	assert.match(editors[0]!.text, /Task ID: run-test-123/);

	// Result reads completed task with claimUsage=false
	editors.length = 0;
	await handler("result run-test-123", ctx);
	assert.equal(editors.length, 1);
	assert.match(editors[0]!.text, /Run ID: run-test-123/);
	assert.match(editors[0]!.text, /Target CWD: \/target\/background\/dir/);
	assert.match(editors[0]!.text, /Output:\s+background result/);
	assert.match(editors[0]!.text, /Native model usage accounting is reserved for tool-result collection/);
});

test("release: calls runtime.releaseContinuation and notifies", async () => {
	let releasedId: string | undefined;
	const runtime = createDummyRuntime({
		releaseContinuation: async (id) => { releasedId = id; },
	});

	const handler = createForgeAgentCommandHandler(runtime, () => undefined);
	const { ctx, notifications } = createDummyContext();

	await handler("release cont-handle-abc", ctx);
	assert.equal(releasedId, "cont-handle-abc");
	assert.ok(notifications.some((n) => n.type === "info" && n.message.includes("continuation cont-handle-abc released")));
});

test("argument completions: flags include --cwd, --keep-context, --continue, and --background", async () => {
	const runtime = createDummyRuntime();
	const completer = createForgeAgentArgumentCompletions(runtime, () => undefined)!;

	const runFlags = await completer("run worker --");
	assert.ok(runFlags);
	const labels = runFlags.map((item) => item.label);
	assert.ok(labels.includes("--backend"));
	assert.ok(labels.includes("--cwd"));
	assert.ok(labels.includes("--keep-context"));
	assert.ok(labels.includes("--continue"));
	assert.ok(labels.includes("--background"));
	assert.ok(labels.includes("--"));

	// Plan does not offer --background
	const planFlags = await completer("plan worker --");
	assert.ok(planFlags);
	const planLabels = planFlags.map((item) => item.label);
	assert.ok(planLabels.includes("--cwd"));
	assert.ok(!planLabels.includes("--background"), "plan completions must not offer --background");

	// Task text stops completion
	const afterTask = await completer("run worker --cwd /tmp task started ");
	assert.equal(afterTask, null);
});
