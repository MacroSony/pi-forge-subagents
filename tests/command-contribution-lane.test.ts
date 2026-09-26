import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORGE_COMMAND_DISCOVERY_EVENT, type ForgeCommandContribution, type ForgeCommandDiscovery } from "@zihanw/pi-forge/command-contribution";
import type { ForgeProfileSummary } from "@zihanw/pi-forge/subagent";
import piForgeSubagents from "../src/index.ts";
import { parsePlanRunArgs, registerForgeAgentCommand, createForgeAgentArgumentCompletions } from "../src/command/forge-agent.ts";
import type { ForgeSubagentRuntime, ForgeSubagentPreparedRun } from "../src/runtime/subagent-runtime.ts";
import { ForgeHostSession } from "../src/host/session.ts";

function createMockEvents(): EventEmitter & { on(event: string, fn: (data: unknown) => void): () => void } {
	const ee = new EventEmitter();
	const originalOn = ee.on.bind(ee);
	(ee as any).on = (event: string, fn: (data: unknown) => void) => {
		originalOn(event, fn);
		if (event === "@zihanw/pi-forge/host/v1/available") {
			queueMicrotask(() => {
				ee.emit("@zihanw/pi-forge/host/v1/available", {
					type: "available",
					hostId: "mock-host",
					protocolVersion: 1,
					minVersion: 1,
					maxVersion: 1,
					capabilities: ["listProfiles", "prepare"],
					generation: 1,
				});
			});
		}
		return () => {
			ee.removeListener(event, fn);
		};
	};
	return ee as any;
}

function createDummyRuntime(overrides: Partial<ForgeSubagentRuntime> = {}): ForgeSubagentRuntime {
	return {
		backendIds: () => ["pi-subprocess-readonly", "pi-bubblewrap-write"],
		descriptors: () => [
			{
				id: "pi-subprocess-readonly",
				version: "v1",
				capabilities: {
					access: {
						readOnlyMountIsolation: false,
						readWriteMountIsolation: false,
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
			{
				id: "pi-bubblewrap-write",
				version: "v1",
				capabilities: {
					access: {
						readOnlyMountIsolation: true,
						readWriteMountIsolation: true,
						symlinkSafeContainment: true,
						processIsolation: true,
						agentNetworkIsolation: true,
					},
					executionBoundaries: ["bubblewrap-write"],
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

function createDummyProfile(id: string, scope: "project" | "global" = "project", description = "Test profile description"): ForgeProfileSummary {
	return {
		profileId: id,
		scope,
		name: `${id} profile`,
		description,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		promptStack: "stack-1",
		usable: true,
		diagnostics: [],
	};
}

test("parser: backend flag before profile and task", () => {
	const parsed = parsePlanRunArgs("plan", "--backend pi-bubblewrap-write project:worker do something");
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.backend, "pi-bubblewrap-write");
		assert.equal(parsed.profile, "project:worker");
		assert.equal(parsed.task, "do something");
	}
});

test("parser: backend flag with '=' before profile and task", () => {
	const parsed = parsePlanRunArgs("plan", "--backend=pi-bubblewrap-write project:worker do something");
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.backend, "pi-bubblewrap-write");
		assert.equal(parsed.profile, "project:worker");
		assert.equal(parsed.task, "do something");
	}
});

test("parser: backend flag after profile but before task", () => {
	const parsed = parsePlanRunArgs("run", "project:worker --backend pi-subprocess-readonly do something");
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.backend, "pi-subprocess-readonly");
		assert.equal(parsed.profile, "project:worker");
		assert.equal(parsed.task, "do something");
	}
});

test("parser: preserves task whitespace and quotes without shell execution", () => {
	const taskInput = 'write a function:  \n  function foo() {\n    return "hello world";\n  }';
	const parsed = parsePlanRunArgs("plan", `project:worker ${taskInput}`);
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.profile, "project:worker");
		assert.equal(parsed.task, taskInput);
	}
});

test("parser: supports '--' task delimiter allowing literal --flags in task", () => {
	const parsed = parsePlanRunArgs("plan", "project:worker --backend=pi-subprocess-readonly -- run test --verbose --backend=foo");
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.backend, "pi-subprocess-readonly");
		assert.equal(parsed.profile, "project:worker");
		assert.equal(parsed.task, "run test --verbose --backend=foo");
	}
});

test("parser: preserves whitespace and quotes after '--' delimiter", () => {
	const taskWithQuotes = 'echo   "literal   spaced"   \'quotes\'';
	const parsed = parsePlanRunArgs("run", `project:worker -- ${taskWithQuotes}`);
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.profile, "project:worker");
		assert.equal(parsed.task, taskWithQuotes);
	}
});

test("parser: rejects unknown flags safely before task", () => {
	const parsed = parsePlanRunArgs("plan", "--unsupported-option project:worker do task");
	assert.equal(parsed.ok, false);
	if (!parsed.ok) {
		assert.match(parsed.error, /Unknown option: --unsupported-option/);
	}
});

test("parser: rejects unknown flags inside task without '--' delimiter", () => {
	const parsed = parsePlanRunArgs("plan", "project:worker run test --verbose");
	assert.equal(parsed.ok, false);
	if (!parsed.ok) {
		assert.match(parsed.error, /Unknown option: --verbose/);
	}
});

test("parser: rejects backend flag specified inside task", () => {
	const parsed = parsePlanRunArgs("plan", "project:worker run something --backend pi-sub");
	assert.equal(parsed.ok, false);
	if (!parsed.ok) {
		assert.match(parsed.error, /--backend must be specified before task/);
	}
});

test("parser: rejects missing backend value", () => {
	const parsed1 = parsePlanRunArgs("plan", "project:worker --backend");
	assert.equal(parsed1.ok, false);
	assert.match(parsed1.error, /--backend requires a backend id value/);

	const parsed2 = parsePlanRunArgs("plan", "project:worker --backend= task");
	assert.equal(parsed2.ok, false);
	assert.match(parsed2.error, /--backend requires a backend id value/);

	const parsed3 = parsePlanRunArgs("plan", "--backend --other project:worker task");
	assert.equal(parsed3.ok, false);
	assert.match(parsed3.error, /--backend requires a backend id value/);
});

test("parser: rejects missing profile or missing task", () => {
	const parsed1 = parsePlanRunArgs("plan", "");
	assert.equal(parsed1.ok, false);

	const parsed2 = parsePlanRunArgs("plan", "project:worker");
	assert.equal(parsed2.ok, false);

	const parsed3 = parsePlanRunArgs("plan", "project:worker --");
	assert.equal(parsed3.ok, false);
});

test("main-contribution dispatch metadata and lifecycle on FORGE_COMMAND_DISCOVERY_EVENT", async () => {
	const events = createMockEvents();
	let registeredForgeAgent: any;
	const pi = {
		events,
		registerCommand: (name: string, cmd: any) => {
			if (name === "forge-agent") registeredForgeAgent = cmd;
		},
	} as any;

	const runtime = createDummyRuntime();
	const unregister = registerForgeAgentCommand(pi, runtime, () => undefined);

	assert.ok(registeredForgeAgent, "forge-agent command must be registered");
	assert.equal(registeredForgeAgent.description, "Plan, run, continue, or inspect human-approved subagent tasks");

	// Synchronous parent discovery via FORGE_COMMAND_DISCOVERY_EVENT
	const discovered: ForgeCommandContribution[] = [];
	const discoveryRequest: ForgeCommandDiscovery = {
		version: 1,
		provide: (contribution) => {
			discovered.push(contribution);
		},
	};

	events.emit(FORGE_COMMAND_DISCOVERY_EVENT, discoveryRequest);

	assert.equal(discovered.length, 1);
	const subagentContrib = discovered[0]!;
	assert.equal(subagentContrib.name, "subagent");
	assert.equal(subagentContrib.description, registeredForgeAgent.description);
	assert.equal(subagentContrib.handler, registeredForgeAgent.handler, "handler must be identical");
	assert.equal(subagentContrib.getArgumentCompletions, registeredForgeAgent.getArgumentCompletions, "completer must be identical");

	// Unregister stops responding to discovery
	unregister();

	const afterUnregister: ForgeCommandContribution[] = [];
	events.emit(FORGE_COMMAND_DISCOVERY_EVENT, {
		version: 1,
		provide: (contribution: ForgeCommandContribution) => {
			afterUnregister.push(contribution);
		},
	});
	assert.equal(afterUnregister.length, 0, "must not provide contribution after unregister");
});

test("extension lifecycle wires shutdown, session_start re-registration, dispose, and never registers /forge", async () => {
	const events = createMockEvents();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function>();

	const pi = {
		events,
		registerCommand: (name: string, cmd: any) => {
			commands.set(name, cmd);
		},
		registerTool: () => undefined,
		getActiveTools: () => [],
		on: (event: string, handler: Function) => {
			handlers.set(event, handler);
		},
	} as any;

	const ext = piForgeSubagents(pi);

	// Invariant: optional MUST NEVER register /forge root
	assert.equal(commands.has("forge"), false, "optional must NEVER register /forge root");
	assert.equal(commands.has("forge-agent"), true, "must register /forge-agent");
	assert.equal(commands.has("subagent"), true, "must register legacy /subagent");

	// Discovery returns 1 contribution
	let discoveredCount = 0;
	events.emit(FORGE_COMMAND_DISCOVERY_EVENT, {
		version: 1,
		provide: (_contribution: ForgeCommandContribution) => { discoveredCount++; },
	} as ForgeCommandDiscovery);
	assert.equal(discoveredCount, 1);

	// Session shutdown stops contribution
	const shutdownHandler = handlers.get("session_shutdown");
	assert.ok(shutdownHandler);
	await shutdownHandler!();

	discoveredCount = 0;
	events.emit(FORGE_COMMAND_DISCOVERY_EVENT, {
		version: 1,
		provide: (_contribution: ForgeCommandContribution) => { discoveredCount++; },
	} as ForgeCommandDiscovery);
	assert.equal(discoveredCount, 0, "contribution must be stopped on session_shutdown");

	// Session start re-registers cleanly without double-providers
	const startHandler = handlers.get("session_start");
	assert.ok(startHandler);
	await startHandler!({ type: "session_start" }, { cwd: "/mock/cwd" });

	discoveredCount = 0;
	events.emit(FORGE_COMMAND_DISCOVERY_EVENT, {
		version: 1,
		provide: (_contribution: ForgeCommandContribution) => { discoveredCount++; },
	} as ForgeCommandDiscovery);
	assert.equal(discoveredCount, 1, "contribution must be re-registered on session_start without duplicates");

	// Dispose clears contribution
	ext.dispose();
	discoveredCount = 0;
	events.emit(FORGE_COMMAND_DISCOVERY_EVENT, {
		version: 1,
		provide: (_contribution: ForgeCommandContribution) => { discoveredCount++; },
	} as ForgeCommandDiscovery);
	assert.equal(discoveredCount, 0, "contribution must be removed on dispose");
});

test("argument completions: first-token subcommands", async () => {
	const runtime = createDummyRuntime();
	const completer = createForgeAgentArgumentCompletions(runtime, () => undefined)!;

	// Empty input lists all first tokens including help and list
	const all = await completer("");
	assert.ok(all);
	const values = all.map((i) => i.value);
	assert.deepEqual(values, ["backends", "config", "help", "list", "plan", "run"]);

	// Partial match
	const h = await completer("h");
	assert.ok(h);
	assert.deepEqual(h.map((i) => i.value), ["help"]);

	const l = await completer("l");
	assert.ok(l);
	assert.deepEqual(l.map((i) => i.value), ["list"]);

	const p = await completer("p");
	assert.ok(p);
	assert.deepEqual(p.map((i) => i.value), ["plan"]);
});

test("argument completions: profile IDs and flags before profile", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-completion-test-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "forge", "subagents.json"),
			JSON.stringify({
				profiles: {
					"project:worker": { enabled: true },
					"global:default": { enabled: true },
					"project:disabled": { enabled: false },
				},
			}),
			"utf8",
		);

		const runtime = createDummyRuntime();
		const mockSession = {
			listProfiles: async () => [
				createDummyProfile("worker", "project", "Worker description"),
				createDummyProfile("default", "global", "Global default description"),
				createDummyProfile("disabled", "project", "Disabled description"),
			],
		} as unknown as ForgeHostSession;

		const mockCtx = {
			cwd,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
		} as any;

		const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => mockCtx)!;

		// Typing 'plan ' offers flags before profile AND enabled profile IDs
		const items = await completer("plan ");
		assert.ok(items);
		const values = items.map((i) => i.value);
		assert.ok(values.includes("plan --backend"));
		assert.ok(values.includes("plan --backend="));
		assert.ok(values.includes("plan --backend=pi-subprocess-readonly"));
		assert.ok(values.includes("plan project:worker"));
		assert.ok(values.includes("plan worker"));
		assert.ok(values.includes("plan global:default"));
		assert.ok(!values.includes("plan project:disabled"), "disabled profile must not be completed");

		// Typing 'plan --b' filters to backend flags
		const flagItems = await completer("plan --b");
		assert.ok(flagItems);
		const flagValues = flagItems.map((i) => i.value);
		assert.ok(flagValues.includes("plan --backend"));
		assert.ok(flagValues.includes("plan --backend="));
		assert.ok(!flagValues.includes("plan project:worker"));

		// Typing 'plan --backend ' completes registered backend IDs
		const backendItems = await completer("plan --backend ");
		assert.ok(backendItems);
		const backendValues = backendItems.map((i) => i.value);
		assert.ok(backendValues.includes("plan --backend pi-subprocess-readonly"));
		assert.ok(backendValues.includes("plan --backend pi-bubblewrap-write"));

		// Typing 'plan --backend=' completes --backend=<id>
		const eqItems = await completer("plan --backend=");
		assert.ok(eqItems);
		const eqValues = eqItems.map((i) => i.value);
		assert.ok(eqValues.includes("plan --backend=pi-subprocess-readonly"));
		assert.ok(eqValues.includes("plan --backend=pi-bubblewrap-write"));

		// After backend flag is consumed, profile IDs are completed
		const afterBackend = await completer("plan --backend pi-subprocess-readonly ");
		assert.ok(afterBackend);
		const afterBackendValues = afterBackend.map((i) => i.value);
		assert.ok(afterBackendValues.includes("plan --backend pi-subprocess-readonly project:worker"));
		assert.ok(!afterBackendValues.includes("plan --backend pi-subprocess-readonly --backend"));

		// After profile is consumed, backend flags and '--' delimiter are completed
		const afterProfile = await completer("plan project:worker ");
		assert.ok(afterProfile);
		const afterProfileValues = afterProfile.map((i) => i.value);
		assert.ok(afterProfileValues.includes("plan project:worker --backend"));
		assert.ok(afterProfileValues.includes("plan project:worker --backend="));
		assert.ok(afterProfileValues.includes("plan project:worker --"));
		assert.ok(!afterProfileValues.includes("plan project:worker project:worker"));

		// Once '-- ' is typed, no completions (task region)
		const inTask = await completer("plan project:worker -- ");
		assert.equal(inTask, null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("argument completions: stops completing task text once task has started", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-task-comp-test-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "forge", "subagents.json"),
			JSON.stringify({ profiles: { "project:worker": { enabled: true } } }),
			"utf8",
		);

		const runtime = createDummyRuntime();
		const mockSession = {
			listProfiles: async () => [createDummyProfile("worker", "project")],
		} as unknown as ForgeHostSession;
		const mockCtx = {
			cwd,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
		} as any;

		const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => mockCtx)!;

		// Once task text has started, do not propose backend or delimiter
		assert.equal(await completer("run project:worker explain "), null);
		assert.equal(await completer("run project:worker explain --"), null);
		assert.equal(await completer("run project:worker do some task "), null);
		assert.equal(await completer("plan --backend pi-subprocess-readonly project:worker fix bug "), null);
		assert.equal(await completer("plan project:worker --backend pi-subprocess-readonly fix bug "), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("argument completions: whitespace boundaries with tab and newline", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-ws-comp-test-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "forge", "subagents.json"),
			JSON.stringify({ profiles: { "project:worker": { enabled: true } } }),
			"utf8",
		);

		const runtime = createDummyRuntime();
		const mockSession = {
			listProfiles: async () => [createDummyProfile("worker", "project")],
		} as unknown as ForgeHostSession;
		const mockCtx = {
			cwd,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
		} as any;

		const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => mockCtx)!;

		// Tab delimiter after profile
		const tabItems = await completer("plan\tproject:worker\t");
		assert.ok(tabItems);
		assert.ok(tabItems.some((i) => i.value.includes("--backend")));
		assert.ok(tabItems.some((i) => i.value.includes("--")));

		// Newline delimiter after profile
		const nlItems = await completer("plan\nproject:worker\n");
		assert.ok(nlItems);
		assert.ok(nlItems.some((i) => i.value.includes("--backend")));
		assert.ok(nlItems.some((i) => i.value.includes("--")));

		// Tab delimiter after --backend
		const tabBackend = await completer("plan\t--backend\t");
		assert.ok(tabBackend);
		assert.ok(tabBackend.some((i) => i.value.includes("pi-subprocess-readonly")));

		// Task started with tab/newline boundaries stops completing
		assert.equal(await completer("plan\tproject:worker\texplain\t"), null);
		assert.equal(await completer("run\nproject:worker\nexplain\n"), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("argument completions: untrusted project context does not expose profile resource IDs", async () => {
	const runtime = createDummyRuntime();
	const mockSession = {
		listProfiles: async () => [createDummyProfile("worker", "project")],
	} as unknown as ForgeHostSession;

	const untrustedCtx = {
		cwd: "/untrusted/repo",
		isProjectTrusted: () => false,
		sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
	} as any;

	const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => untrustedCtx)!;

	const items = await completer("plan ");
	assert.ok(items);
	const values = items.map((i) => i.value);
	// Proposes backend flags, but NOT project profile resource IDs
	assert.ok(values.includes("plan --backend"));
	assert.ok(!values.includes("plan project:worker"), "untrusted context must not expose project profile IDs");
	assert.ok(!values.includes("plan worker"));
});

test("argument completions: controlled-held listProfiles async fencing", async () => {
	const cwdAlpha = mkdtempSync(join(tmpdir(), "pi-forge-fence-alpha-"));
	const cwdBeta = mkdtempSync(join(tmpdir(), "pi-forge-fence-beta-"));
	try {
		mkdirSync(join(cwdAlpha, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(cwdAlpha, ".pi", "forge", "subagents.json"),
			JSON.stringify({ profiles: { "project:worker": { enabled: true } } }),
			"utf8",
		);

		const runtime = createDummyRuntime();

		// Case A: cwd changes while held
		{
			let resolveHeld!: (profiles: ForgeProfileSummary[]) => void;
			const heldPromise = new Promise<ForgeProfileSummary[]>((res) => { resolveHeld = res; });
			const mockSession = { listProfiles: () => heldPromise } as any;

			let activeCtx = {
				cwd: cwdAlpha,
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
			} as any;

			const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => activeCtx)!;
			const completionPromise = completer("plan ");

			activeCtx.cwd = cwdBeta;
			resolveHeld([createDummyProfile("worker", "project")]);

			const result = await completionPromise;
			const values = (result ?? []).map((i) => i.value);
			assert.ok(!values.includes("plan project:worker"), "late async reply must be rejected on cwd change");
		}

		// Case B: sessionId changes while held (session switched)
		{
			let resolveHeld!: (profiles: ForgeProfileSummary[]) => void;
			const heldPromise = new Promise<ForgeProfileSummary[]>((res) => { resolveHeld = res; });
			const mockSession = { listProfiles: () => heldPromise } as any;

			let currentSessionId = "s-orig";
			const activeCtx = {
				cwd: cwdAlpha,
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => currentSessionId, getLeafId: () => "l1" },
			} as any;

			const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => activeCtx)!;
			const completionPromise = completer("plan ");

			currentSessionId = "s-new";
			resolveHeld([createDummyProfile("worker", "project")]);

			const result = await completionPromise;
			const values = (result ?? []).map((i) => i.value);
			assert.ok(!values.includes("plan project:worker"), "late async reply must be rejected on sessionId change");
		}

		// Case C: leafId changes while held (tree navigation / branch switch)
		{
			let resolveHeld!: (profiles: ForgeProfileSummary[]) => void;
			const heldPromise = new Promise<ForgeProfileSummary[]>((res) => { resolveHeld = res; });
			const mockSession = { listProfiles: () => heldPromise } as any;

			let currentLeafId = "leaf-old";
			const activeCtx = {
				cwd: cwdAlpha,
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "s1", getLeafId: () => currentLeafId },
			} as any;

			const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => activeCtx)!;
			const completionPromise = completer("plan ");

			currentLeafId = "leaf-new";
			resolveHeld([createDummyProfile("worker", "project")]);

			const result = await completionPromise;
			const values = (result ?? []).map((i) => i.value);
			assert.ok(!values.includes("plan project:worker"), "late async reply must be rejected on leaf change");
		}

		// Case D: project trust revoked while held
		{
			let resolveHeld!: (profiles: ForgeProfileSummary[]) => void;
			const heldPromise = new Promise<ForgeProfileSummary[]>((res) => { resolveHeld = res; });
			const mockSession = { listProfiles: () => heldPromise } as any;

			let isTrusted = true;
			const activeCtx = {
				cwd: cwdAlpha,
				isProjectTrusted: () => isTrusted,
				sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
			} as any;

			const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => activeCtx)!;
			const completionPromise = completer("plan ");

			isTrusted = false;
			resolveHeld([createDummyProfile("worker", "project")]);

			const result = await completionPromise;
			const values = (result ?? []).map((i) => i.value);
			assert.ok(!values.includes("plan project:worker"), "late async reply must be rejected on trust revocation");
		}

		// Case E: session shutdown while held
		{
			let resolveHeld!: (profiles: ForgeProfileSummary[]) => void;
			const heldPromise = new Promise<ForgeProfileSummary[]>((res) => { resolveHeld = res; });
			let currentSession: any = { listProfiles: () => heldPromise };

			const activeCtx = {
				cwd: cwdAlpha,
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
			} as any;

			const completer = createForgeAgentArgumentCompletions(runtime, () => currentSession, () => activeCtx)!;
			const completionPromise = completer("plan ");

			currentSession = undefined;
			resolveHeld([createDummyProfile("worker", "project")]);

			const result = await completionPromise;
			const values = (result ?? []).map((i) => i.value);
			assert.ok(!values.includes("plan project:worker"), "late async reply must be rejected on session shutdown");
		}

		// Case F: nothing changed while held -> completions accepted
		{
			let resolveHeld!: (profiles: ForgeProfileSummary[]) => void;
			const heldPromise = new Promise<ForgeProfileSummary[]>((res) => { resolveHeld = res; });
			const mockSession = { listProfiles: () => heldPromise } as any;

			const activeCtx = {
				cwd: cwdAlpha,
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "s1", getLeafId: () => "l1" },
			} as any;

			const completer = createForgeAgentArgumentCompletions(runtime, () => mockSession, () => activeCtx)!;
			const completionPromise = completer("plan ");

			resolveHeld([createDummyProfile("worker", "project")]);

			const result = await completionPromise;
			assert.ok(result);
			const values = result.map((i) => i.value);
			assert.ok(values.includes("plan project:worker"), "fenced completion succeeds when context is stable");
		}
	} finally {
		rmSync(cwdAlpha, { recursive: true, force: true });
		rmSync(cwdBeta, { recursive: true, force: true });
	}
});

test("argument completions: context tracking callback does not leak old cwd across session switch", async () => {
	let currentCwd = "/workspace/project-alpha";
	const runtime = {
		backendIds: () => ["pi-subprocess-readonly"],
		descriptors: (ctx: any) => {
			assert.equal(ctx.cwd, currentCwd, "descriptors MUST receive the active session context");
			return [{ id: `backend-for-${ctx.cwd.split("/").pop()}`, version: "v1", capabilities: {} as any }];
		},
		prepare: async () => ({ ok: false as const, diagnostics: [] }),
		discard: async () => undefined,
		execute: async () => { throw new Error("not executed"); },
		dispose: async () => undefined,
	} as unknown as ForgeSubagentRuntime;

	const completer = createForgeAgentArgumentCompletions(
		runtime,
		() => undefined,
		() => ({ cwd: currentCwd } as any),
	)!;

	// In project-alpha
	const alphaItems = await completer("plan --backend ");
	assert.ok(alphaItems);
	assert.ok(alphaItems.some((i) => i.value.includes("backend-for-project-alpha")));

	// Switch session to project-beta
	currentCwd = "/workspace/project-beta";

	const betaItems = await completer("plan --backend ");
	assert.ok(betaItems);
	assert.ok(betaItems.some((i) => i.value.includes("backend-for-project-beta")));
	assert.ok(!betaItems.some((i) => i.value.includes("backend-for-project-alpha")), "must not leak old cwd");
});

test("list subcommand displays enabled configured profiles with scoped IDs and descriptions with no inference", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-list-test-"));

	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "forge", "subagents.json"),
			JSON.stringify({ profiles: { "project:auditor": { enabled: true } } }),
			"utf8",
		);

		let prepareCalled = false;
		let executeCalled = false;
		const runtime = createDummyRuntime({
			prepare: async () => {
				prepareCalled = true;
				return { ok: false as const, diagnostics: [] };
			},
			execute: async () => {
				executeCalled = true;
				throw new Error("execute must not be called during list");
			},
		});

		const session = {
			listProfiles: async () => [
				createDummyProfile("auditor", "project", "Specialized security auditor profile"),
				createDummyProfile("disabled-profile", "project", "This profile is disabled"),
			],
		} as unknown as ForgeHostSession;

		let capturedCommand: any;
		const pi = {
			registerCommand: (_name: string, cmd: any) => { capturedCommand = cmd; },
		} as any;

		registerForgeAgentCommand(pi, runtime, () => session);

		const editors: { title: string; text: string }[] = [];
		const ctx = {
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "s" },
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
			ui: {
				theme: { fg: (_c: string, text: string) => text },
				notify: () => undefined,
				setStatus: () => undefined,
				editor: async (title: string, text: string) => { editors.push({ title, text }); },
			},
		} as any;

		await capturedCommand.handler("list", ctx);

		assert.equal(prepareCalled, false, "no prepare/inference during list");
		assert.equal(executeCalled, false, "no execute/inference during list");
		assert.equal(editors.length, 1);
		assert.match(editors[0]!.text, /Enabled subagent profiles/);
		assert.match(editors[0]!.text, /project:auditor/);
		assert.match(editors[0]!.text, /Specialized security auditor profile/);
		assert.doesNotMatch(editors[0]!.text, /disabled-profile/, "disabled profile must not be listed");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("approval invariants: run requires interactive approval, cancels on rejection, rejects non-UI", async () => {
	let discardCalled = false;
	let executeCalled = false;

	const dummyPrepared: ForgeSubagentPreparedRun = {
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
			runId: "run-1",
			requestId: "req-1",
			preflightId: "pre-1",
			profile: {
				profileId: "project:worker",
				profile: { id: "worker", thinkingLevel: "high" } as any,
				promptStackId: "stack-1",
			} as any,
			backendId: "pi-subprocess-readonly",
			model: { provider: "test", id: "model-1" },
			thinkingLevel: "high",
			effectiveToolIds: [],
			systemPrompt: "sys",
			messages: [],
			conversationFingerprint: "sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
			executionFingerprint: "sha256:v1:0000000000000000000000000000000000000000000000000000000000000000",
			access: {
				level: "read-only",
				executionBoundary: "shared-user",
				mounts: [],
				process: false,
			} as any,
		} as any,
		diagnostics: [],
	};

	const runtime = createDummyRuntime({
		prepare: async () => ({ ok: true as const, prepared: dummyPrepared }),
		discard: async () => { discardCalled = true; },
		execute: async () => {
			executeCalled = true;
			return {
				status: "completed",
				backendId: "pi-subprocess-readonly",
				model: { provider: "test", id: "model-1" },
				durationMs: 10,
				effectiveToolIds: [],
			} as any;
		},
	});

	const session = {
		listProfiles: async () => [createDummyProfile("worker")],
	} as unknown as ForgeHostSession;

	let captured: any;
	const pi = {
		registerCommand: (_name: string, cmd: any) => { captured = cmd; },
	} as any;

	registerForgeAgentCommand(pi, runtime, () => session);

	// Case 1: non-UI run is rejected immediately without prepare
	const nonUiNotifications: Array<{ message: string; type: string }> = [];
	const nonUiCtx = {
		cwd: "/tmp",
		hasUI: false,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "s" },
		modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
		ui: {
			notify: (message: string, type: string) => { nonUiNotifications.push({ message, type }); },
			setStatus: () => undefined,
			theme: { fg: (_c: string, text: string) => text },
		},
	} as any;

	await captured.handler("run worker task", nonUiCtx);
	assert.ok(nonUiNotifications.some((n) => n.type === "error" && n.message.includes("requires interactive provider-egress confirmation")));
	assert.equal(discardCalled, false);
	assert.equal(executeCalled, false);

	// Case 2: interactive UI rejects confirmation -> discards prepared, does NOT execute
	const rejectedNotifications: Array<{ message: string; type: string }> = [];
	const rejectingUiCtx = {
		cwd: "/tmp",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "s" },
		modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
		ui: {
			notify: (message: string, type: string) => { rejectedNotifications.push({ message, type }); },
			setStatus: () => undefined,
			theme: { fg: (_c: string, text: string) => text },
			select: async () => "Reject", // User denies approval
		},
		signal: undefined,
	} as any;

	discardCalled = false;
	executeCalled = false;
	await captured.handler("run worker task", rejectingUiCtx);
	assert.equal(discardCalled, true, "prepared run must be discarded on denial");
	assert.equal(executeCalled, false, "execution MUST NOT proceed on denial");
	assert.ok(rejectedNotifications.some((n) => n.message.includes("cancelled before provider transport")));
});

test("legacy /subagent preserves old smoke semantics without aliasing to runtime", async () => {
	const events = createMockEvents();
	const commands = new Map<string, any>();

	const pi = {
		events,
		registerCommand: (name: string, cmd: any) => { commands.set(name, cmd); },
		registerTool: () => undefined,
		getActiveTools: () => [],
		on: () => undefined,
	} as any;

	let sessionPrepareCalled = false;
	const mockSession = {
		listProfiles: async () => [createDummyProfile("worker", "project")],
		prepare: async (req: any) => {
			sessionPrepareCalled = true;
			assert.equal(req.backend.model.provider, "unknown", "must use legacy smoke provider: unknown");
			return { systemPrompt: "smoke-system-prompt" };
		},
		dispose: () => undefined,
	};

	piForgeSubagents(pi);
	const subagentCmd = commands.get("subagent");
	assert.ok(subagentCmd);

	const notifications: string[] = [];
	const ctx = {
		ui: {
			notify: (msg: string) => { notifications.push(msg); },
		},
	} as any;

	// Fake session on context
	(piForgeSubagents as any);
	// Test help subcommand
	await subagentCmd.handler("help", ctx);
	assert.ok(notifications.some((n) => n.includes("Legacy host smoke test helper")));

	// Test plan without session warns
	notifications.length = 0;
	await subagentCmd.handler("plan worker test task", ctx);
	assert.ok(notifications.some((n) => n.includes("no Forge host session")));
});

test("extension wires session_tree, session_compact, and session_before_switch/fork context updates", async () => {
	const events = createMockEvents();
	const handlers = new Map<string, Function>();

	const pi = {
		events,
		registerCommand: () => undefined,
		registerTool: () => undefined,
		getActiveTools: () => [],
		on: (event: string, handler: Function) => {
			handlers.set(event, handler);
		},
	} as any;

	const ext = piForgeSubagents(pi);

	// Initial start
	const startHandler = handlers.get("session_start")!;
	await startHandler({ type: "session_start" }, { cwd: "/project-1", sessionManager: { getSessionId: () => "s1" } });

	// session_tree updates context
	const treeHandler = handlers.get("session_tree")!;
	await treeHandler({ type: "session_tree" }, { cwd: "/project-1-branch", sessionManager: { getSessionId: () => "s1", getLeafId: () => "l2" } });

	// session_compact updates context
	const compactHandler = handlers.get("session_compact")!;
	await compactHandler({ type: "session_compact" }, { cwd: "/project-1-compacted", sessionManager: { getSessionId: () => "s1" } });

	// Pre-switch can be cancelled; absence of a replacement must not erase context.
	const switchHandler = handlers.get("session_before_switch")!;
	await switchHandler({ type: "session_before_switch" });

	// Pre-fork can also be cancelled.
	const forkHandler = handlers.get("session_before_fork")!;
	await forkHandler({ type: "session_before_fork" });

	ext.dispose();
});

test("late host connect cannot resurrect a shutdown or replace a newer session contribution", async (t) => {
	const pending: Array<(session: ForgeHostSession) => void> = [];
	t.mock.method(ForgeHostSession, "connect", () => new Promise<ForgeHostSession>(resolve => pending.push(resolve)));
	const events = createMockEvents(), handlers = new Map<string, Function>();
	const pi = { events, registerCommand() {}, registerTool() {}, getActiveTools: () => [], on(name: string, handler: Function) { handlers.set(name, handler); } } as any;
	const ext = piForgeSubagents(pi);
	const count = () => { let n = 0; events.emit(FORGE_COMMAND_DISCOVERY_EVENT, { version: 1, provide() { n++; } }); return n; };
	const cwd = mkdtempSync(join(tmpdir(), "forge-command-lifecycle-"));
	const ctx = (id: string) => ({ cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => id } });
	const closed: string[] = [];
	const connection = (id: string) => ({ dispose() { closed.push(id); }, async listProfiles() { return []; } }) as unknown as ForgeHostSession;
	try {
		const first = handlers.get("session_start")!({}, ctx("one"));
		await handlers.get("session_shutdown")!();
		pending.shift()!(connection("stale-shutdown")); await first;
		assert.equal(ext.session, undefined); assert.equal(count(), 0); assert.ok(closed.includes("stale-shutdown"));
		const old = handlers.get("session_start")!({}, ctx("old"));
		const newer = handlers.get("session_start")!({}, ctx("new"));
		const resolveOld = pending.shift()!, resolveNew = pending.shift()!;
		const newest = connection("newest"); resolveNew(newest); await newer;
		assert.equal(ext.session, newest); assert.equal(count(), 1);
		resolveOld(connection("stale-replaced")); await old;
		assert.equal(ext.session, newest); assert.equal(count(), 1); assert.ok(closed.includes("stale-replaced"));
		const last = handlers.get("session_start")!({}, ctx("dispose-pending")); ext.dispose();
		pending.shift()!(connection("stale-disposed")); await last;
		assert.equal(ext.session, undefined); assert.equal(count(), 0); assert.ok(closed.includes("stale-disposed"));
	} finally { ext.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("stale description refresh cannot register a tool after lifecycle invalidation", async () => {
	const { registerForgeSubagentTool } = await import("../src/tool/forge-subagent.ts");
	let resolve!: (value: string) => void; let current = true;
	const descriptions: string[] = [];
	const refresh = registerForgeSubagentTool({ registerTool(t: any) { descriptions.push(t.description); } } as any, createDummyRuntime(), {
		sessionProvider: () => undefined, summarize: () => new Promise<string>(r => { resolve = r; }),
	});
	const pending = refresh({} as any, () => current);
	current = false; resolve("STALE_DESCRIPTION"); await pending;
	assert.equal(descriptions.length, 1); assert.doesNotMatch(descriptions[0]!, /STALE_DESCRIPTION/);
});
