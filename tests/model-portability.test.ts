import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgePrepareRequest, ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import { negotiateSubagentTools, subagentPromptStackFingerprint, subagentSourceProfileFingerprint, type AgentProfileSnapshot } from "../src/contract/index.ts";
import { DeterministicFakeBackend } from "@zihanw/pi-subagent-runtime/testing";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import type { ForgeHostSession } from "../src/host/session.ts";

const SNAPSHOT: AgentProfileSnapshot = {
	schemaVersion: 1,
	profileId: "project:worker",
	profile: {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "worker",
		model: { provider: "test-provider", id: "model-x" },
		thinkingLevel: "high",
		promptStack: "worker",
	},
	promptStackId: "project:worker",
	promptStack: { schemaVersion: 1, id: "worker", items: [] },
	dependencies: [],
	profileFingerprint: `sha256:v1:${"0".repeat(64)}`,
	promptStackFingerprint: `sha256:v1:${"0".repeat(64)}`,
};

SNAPSHOT.profileFingerprint = subagentSourceProfileFingerprint(SNAPSHOT.profile);
SNAPSHOT.promptStackFingerprint = subagentPromptStackFingerprint(SNAPSHOT.promptStack!);

function fakeSession(): ForgeHostSession {
	const session = {
		resolveProfile: async () => ({ snapshot: SNAPSHOT }),
		prepare: async (request: ForgePrepareRequest) => {
			const negotiation = negotiateSubagentTools(
				request.backend.toolCatalog as never,
				undefined,
				{ level: request.access.level, network: request.access.network, allowProcess: request.access.allowProcess } as never,
			);
			const response: ForgePrepareResponse = {
				profileId: "project:worker",
				model: request.backend.model,
				thinkingLevel: "high",
				systemPrompt: "You are a focused reviewer.",
				messages: [{ role: "user", content: [{ type: "text", text: "Review the patch." }], protectedTask: true, source: "delegated-task" }],
				effectiveToolIds: negotiation.effectiveToolIds,
				effectiveToolNames: negotiation.effectiveToolNames,
				diagnostics: negotiation.diagnostics,
				profileSnapshot: SNAPSHOT,
				preparedAt: "2026-07-14T00:00:00.000Z",
			};
			return response;
		},
	} as unknown as ForgeHostSession;
	return session;
}

function fakeCtx(cwd: string, registryOverrides: Record<string, unknown> = {}): any {
	return {
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session-1" },
		signal: undefined,
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			find: () => undefined,
			hasConfiguredAuth: () => false,
			...registryOverrides,
		},
	};
}

function setupCwd(): string {
	const cwd = `/tmp/pi-forge-subagents-portability-${Math.random().toString(36).slice(2)}`;
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
		profiles: { "project:worker": { enabled: true } },
	}), "utf8");
	return cwd;
}

function makeRuntime(backendId: string): { runtime: ReturnType<typeof createForgeSubagentRuntime>; backend: DeterministicFakeBackend } {
	const backend = new DeterministicFakeBackend({ id: backendId, fidelity: "backend-assisted" });
	const runtime = createForgeSubagentRuntime(fakeSession, {
		builtInBackends: false,
		extraBackends: [backend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});
	return { runtime, backend };
}

test("fresh-process backend rejects an extension-registered provider with streamSimple", async () => {
	const { runtime, backend } = makeRuntime("pi-subprocess-readonly");
	const cwd = setupCwd();
	const ctx = fakeCtx(cwd, {
		getRegisteredProviderIds: () => ["ext-stream"],
		getRegisteredProviderConfig: (provider: string) =>
			provider === "ext-stream" ? { streamSimple: () => undefined } : undefined,
	});
	try {
		const preparation = await runtime.prepare("project:worker", "Review the patch.", ctx, {
			backendId: "pi-subprocess-readonly",
			model: { provider: "ext-stream", id: "ext-model" },
		});
		assert.equal(preparation.ok, false);
		if (!preparation.ok) {
			const diagnostic = preparation.diagnostics.find((d) => d.code === "host.model-not-portable");
			assert.ok(diagnostic, preparation.diagnostics.map((d) => d.message).join("; "));
			assert.match(diagnostic.message, /registered by a Pi extension/);
			assert.match(diagnostic.message, /--no-extensions/);
			assert.match(diagnostic.message, /pi-inprocess/);
			assert.doesNotMatch(diagnostic.message, /declarative/);
		}
		assert.equal(backend.preflightCalls.length, 0, "preflight must not run for a non-portable model");
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("built-in provider passes without the diagnostic (facade without probe methods)", async () => {
	const { runtime, backend } = makeRuntime("pi-subprocess-readonly");
	const cwd = setupCwd();
	const ctx = fakeCtx(cwd);
	try {
		const preparation = await runtime.prepare("project:worker", "Review the patch.", ctx, {
			backendId: "pi-subprocess-readonly",
		});
		assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.diagnostics.map((d) => d.message).join("; "));
		if (preparation.ok) {
			assert.ok(!preparation.prepared.diagnostics.some((d) => d.code === "host.model-not-portable"));
		}
		assert.equal(backend.preflightCalls.length, 1);
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("declarative extension provider diagnostic carries the declarative note", async () => {
	const { runtime } = makeRuntime("pi-rpc-readonly");
	const cwd = setupCwd();
	const ctx = fakeCtx(cwd, {
		getRegisteredProviderIds: () => ["declarative"],
		getRegisteredProviderConfig: (provider: string) =>
			provider === "declarative" ? { name: "Declarative", models: [] } : undefined,
	});
	try {
		const preparation = await runtime.prepare("project:worker", "Review the patch.", ctx, {
			backendId: "pi-rpc-readonly",
			model: { provider: "declarative", id: "declarative-model" },
		});
		assert.equal(preparation.ok, false);
		if (!preparation.ok) {
			const diagnostic = preparation.diagnostics.find((d) => d.code === "host.model-not-portable");
			assert.ok(diagnostic);
			assert.match(diagnostic.message, /declarative/);
		}
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("provider unknown to every probe method is treated as not extension-registered", async () => {
	const { runtime } = makeRuntime("pi-subprocess-readonly");
	const cwd = setupCwd();
	const ctx = fakeCtx(cwd, {
		getRegisteredProviderIds: () => [],
		getRegisteredNativeProvider: () => undefined,
		getRegisteredProviderConfig: () => undefined,
	});
	try {
		const preparation = await runtime.prepare("project:worker", "Review the patch.", ctx, {
			backendId: "pi-subprocess-readonly",
			model: { provider: "unknown-provider", id: "unknown-model" },
		});
		assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.diagnostics.map((d) => d.message).join("; "));
		if (preparation.ok) {
			assert.ok(!preparation.prepared.diagnostics.some((d) => d.code === "host.model-not-portable"));
		}
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("pi-inprocess does not reject an extension-registered provider", async () => {
	const { runtime, backend } = makeRuntime("pi-inprocess");
	const cwd = setupCwd();
	const ctx = fakeCtx(cwd, {
		getRegisteredProviderIds: () => ["ext-stream"],
		getRegisteredProviderConfig: (provider: string) =>
			provider === "ext-stream" ? { streamSimple: () => undefined } : undefined,
	});
	try {
		const preparation = await runtime.prepare("project:worker", "Review the patch.", ctx, {
			backendId: "pi-inprocess",
			model: { provider: "ext-stream", id: "ext-model" },
		});
		assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.diagnostics.map((d) => d.message).join("; "));
		if (preparation.ok) {
			assert.ok(!preparation.prepared.diagnostics.some((d) => d.code === "host.model-not-portable"));
		}
		assert.equal(backend.preflightCalls.length, 1);
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("native extension provider is rejected on a fresh-process backend", async () => {
	const { runtime } = makeRuntime("pi-subprocess-readonly");
	const cwd = setupCwd();
	const ctx = fakeCtx(cwd, {
		getRegisteredNativeProvider: (provider: string) =>
			provider === "native-ext" ? { id: "native-ext" } : undefined,
	});
	try {
		const preparation = await runtime.prepare("project:worker", "Review the patch.", ctx, {
			backendId: "pi-subprocess-readonly",
			model: { provider: "native-ext", id: "native-model" },
		});
		assert.equal(preparation.ok, false);
		if (!preparation.ok) {
			assert.ok(preparation.diagnostics.some((d) => d.code === "host.model-not-portable"));
		}
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
