import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import piForge from "@zihanw/pi-forge";
import { DeterministicFakeBackend } from "@zihanw/pi-subagent-runtime/testing";
import { ForgeHostSession } from "../src/host/session.ts";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import type { PromptToolPolicy, SubagentBackendTool } from "../src/contract/index.ts";

const TEST_TIMEOUT_MS = 8_000;
const RUN_TIMEOUT_MS = 1_000;

const USABLE_TOOLS: SubagentBackendTool[] = [
	// Empty effects are intentional: the initial-only case must prove selection,
	// not merely pass because request access removed write.
	{ id: "tool.read", name: "read", effects: [] },
	{ id: "tool.write", name: "write", effects: [] },
];
const ACCESS_FILTERED_TOOLS: SubagentBackendTool[] = [
	{ id: "tool.read", name: "read", effects: [] },
	{ id: "tool.write", name: "write", effects: ["filesystem-write"] },
];

interface Harness {
	cwd: string;
	ctx: any;
	session: ForgeHostSession;
	backend: any;
	cleanup(): void;
}

async function setupHarness(tools: PromptToolPolicy | undefined, catalog: SubagentBackendTool[]): Promise<Harness> {
	const cwd = mkdtempSync(join(tmpdir(), "forge-cross-package-"));
	mkdirSync(join(cwd, ".pi", "forge", "prompt-stacks"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "forge", "agent-profiles"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "prompt-stacks", "worker.json"), JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.prompt-stack",
		id: "worker",
		tools,
		items: [{ kind: "block", id: "system", role: "system", content: "You are a worker." }],
	}), "utf8");
	writeFileSync(join(cwd, ".pi", "forge", "agent-profiles", "worker.json"), JSON.stringify({
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "worker",
		model: { provider: "test", id: "model-x" },
		thinkingLevel: "high",
		promptStack: "worker",
	}), "utf8");
	writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
		profiles: { "project:worker": { enabled: true, backend: "fake-test-backend" } },
	}), "utf8");

	const bus = {
		handlers: new Map<string, Set<(data: unknown) => void>>(),
		emit(channel: string, data: unknown) {
			for (const handler of this.handlers.get(channel) ?? []) handler(data);
		},
		on(channel: string, handler: (data: unknown) => void) {
			const handlers = this.handlers.get(channel) ?? new Set();
			handlers.add(handler);
			this.handlers.set(channel, handlers);
			return () => handlers.delete(handler);
		},
	};
	const extensionHandlers = new Map<string, Function>();
	const pi = {
		events: bus,
		on(event: string, handler: Function) { extensionHandlers.set(event, handler); },
		registerCommand() {}, registerTool() {},
		getActiveTools: () => ["read", "write"], getAllTools: () => [{ name: "read" }, { name: "write" }],
		setActiveTools() {}, getThinkingLevel: () => "high", setThinkingLevel() {},
		getModel: () => ({ provider: "test", id: "model-x" }), appendEntry() {},
	};
	piForge(pi as any);
	const ctx = {
		cwd, isProjectTrusted: () => true, model: { provider: "test", id: "model-x" }, isIdle: () => true,
		sessionManager: { getSessionId: () => "cross-package", getLeafId: () => "leaf", getBranch: () => [], getEntries: () => [] },
		modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
		ui: { setStatus() {}, notify() {}, theme: { fg: (_color: unknown, text: string) => text } },
	};
	await extensionHandlers.get("session_start")?.({ reason: "startup" }, ctx);
	await extensionHandlers.get("resources_discover")?.({ cwd, reason: "startup" }, ctx);
	const session = await ForgeHostSession.connect(bus, { defaultTimeoutMs: 1_000 });
	const fake = new DeterministicFakeBackend({ id: "fake-test-backend", fidelity: "backend-assisted" });
	fake.executionMode = "completed";
	// Keep the deterministic execution, but expose this scenario's catalog to
	// preflight so the host's public catalog and the optional plan use the same facts.
	const backend = {
		...fake,
		descriptor: fake.descriptor,
		preflight(input: unknown) {
			const result = fake.preflight(input as never);
			return result.status === "accepted" ? { ...result, toolCatalog: structuredClone(catalog) } : result;
		},
		prepare: fake.prepare.bind(fake),
		start: fake.start.bind(fake),
		discard: fake.discard.bind(fake),
	};
	return { cwd, ctx, session, backend, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

interface Scenario {
	name: string;
	tools: PromptToolPolicy;
	catalog?: SubagentBackendTool[];
	expected: string[];
	diagnostic?: { code: string; path?: string };
}

const scenarios: Scenario[] = [
	{
		name: "initial-only read does not include usable write",
		tools: { initial: ["read"] },
		expected: ["tool.read"],
	},
	{ name: "empty initial selects no tools", tools: { initial: [] }, expected: [] },
	{ name: "omitted initial keeps legacy allow selection", tools: { allow: ["read", "write"] }, expected: ["tool.read", "tool.write"] },
	{ name: "deny policy removes write", tools: { deny: ["write"] }, expected: ["tool.read"] },
	{
		name: "request access filters selected write",
		tools: { allow: ["read", "write"], initial: ["read", "write"] },
		catalog: ACCESS_FILTERED_TOOLS,
		expected: ["tool.read"],
		diagnostic: { code: "tools.access-filtered", path: "tools.write" },
	},
	{
		name: "missing initial tool warns and keeps registered read",
		tools: { allow: ["*"], initial: ["read", "missing"] },
		expected: ["tool.read"],
		diagnostic: { code: "tools.initial-missing", path: "tools.initial.missing" },
	},
];

for (const scenario of scenarios) {
	test(`cross-package public prepare -> plan -> inert execute: ${scenario.name}`, { timeout: TEST_TIMEOUT_MS }, async () => {
		const harness = await setupHarness(scenario.tools, scenario.catalog ?? USABLE_TOOLS);
		const runtime = createForgeSubagentRuntime(() => harness.session, {
			builtInBackends: false,
			extraBackends: [harness.backend],
			intentToolCatalog: scenario.catalog ?? USABLE_TOOLS,
		});
		try {
			const prepared = await runtime.prepare("project:worker", "Delegated task.", harness.ctx, {
				backendId: "fake-test-backend",
				timeoutMs: RUN_TIMEOUT_MS,
			});
			assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.diagnostics.map((item) => item.message).join("; "));
			if (!prepared.ok) throw new Error("prepare unexpectedly failed");
			assert.deepEqual(prepared.prepared.plan.effectiveToolIds, scenario.expected);
			if (scenario.diagnostic) {
				const diagnostic = scenario.diagnostic;
				assert.ok(prepared.prepared.diagnostics.some((item) => item.code === diagnostic.code && item.path === diagnostic.path));
			}
			const result = await runtime.execute(prepared.prepared, harness.ctx);
			assert.equal(result.status, "completed");
		} finally {
			await runtime.dispose();
			harness.session.dispose();
			harness.cleanup();
		}
	});
}
