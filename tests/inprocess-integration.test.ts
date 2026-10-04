import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TranscriptContext, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ForgePrepareRequest, ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import {
	negotiateSubagentTools,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	type AgentProfileSnapshot,
} from "../src/contract/index.ts";
import type { ForgeHostSession } from "../src/host/session.ts";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";

const PROVIDER = "pi-forge-subagents-inprocess-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-forge-subagents-inprocess-api";

/**
 * End-to-end integration between the host runtime and the real in-process
 * backend: an extension-registered provider (custom streamSimple) must run
 * through pi-inprocess and must be rejected early on fresh-process backends.
 */
test("Forge runtime runs an extension-registered provider through pi-inprocess", async () => {
	const faux = createFauxCore({
		api: API,
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
	});
	faux.setResponses([() => fauxAssistantMessage("In-process integration passed.")]);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(PROVIDER, {
		api: API,
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-key",
		streamSimple: (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) =>
			faux.streamSimple(model, context, options),
		models: [{
			id: MODEL_ID,
			name: "Fixture model",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		}],
	});
	const modelRegistry = new ModelRegistry(modelRuntime);

	// The portability guard relies on these real facade probes existing.
	const probe = modelRegistry as unknown as Record<string, unknown>;
	assert.equal(typeof probe.getRegisteredProviderIds, "function");
	assert.equal(typeof probe.getRegisteredProviderConfig, "function");
	assert.ok(
		(modelRegistry as any).getRegisteredProviderIds().includes(PROVIDER),
		"fixture provider should be extension-registered",
	);

	const snapshot: AgentProfileSnapshot = {
		schemaVersion: 1,
		profileId: "project:worker",
		profile: {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider: PROVIDER, id: MODEL_ID },
			thinkingLevel: "medium",
			promptStack: "worker",
		},
		promptStackId: "project:worker",
		promptStack: { schemaVersion: 1, id: "worker", items: [] },
		dependencies: [],
		profileFingerprint: `sha256:v1:${"0".repeat(64)}`,
		promptStackFingerprint: `sha256:v1:${"0".repeat(64)}`,
	};
	snapshot.profileFingerprint = subagentSourceProfileFingerprint(snapshot.profile);
	snapshot.promptStackFingerprint = subagentPromptStackFingerprint(snapshot.promptStack!);

	const session = {
		resolveProfile: async () => ({ snapshot }),
		prepare: async (request: ForgePrepareRequest) => {
			const negotiation = negotiateSubagentTools(
				request.backend.toolCatalog as never,
				undefined,
				{ level: request.access.level, network: request.access.network, allowProcess: request.access.allowProcess } as never,
			);
			const response: ForgePrepareResponse = {
				profileId: "project:worker",
				model: request.backend.model,
				thinkingLevel: "medium",
				systemPrompt: "You are a focused worker.",
				messages: [{ role: "user", content: [{ type: "text", text: "Say the integration phrase." }], protectedTask: true, source: "delegated-task" }],
				effectiveToolIds: negotiation.effectiveToolIds,
				effectiveToolNames: negotiation.effectiveToolNames,
				diagnostics: negotiation.diagnostics,
				profileSnapshot: snapshot,
				preparedAt: "2026-07-14T00:00:00.000Z",
			};
			return response;
		},
	} as unknown as ForgeHostSession;

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-inprocess-"));
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "forge", "subagents.json"),
		JSON.stringify({
			profiles: {
				"project:worker": { enabled: true, backend: "pi-inprocess" },
			},
		}),
		"utf8",
	);
	const ctx = {
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "inprocess-integration-session" },
		signal: undefined,
		modelRegistry,
	} as any;

	const runtime = createForgeSubagentRuntime(() => session, {});
	try {
		// Fresh-process backends must fail fast with the portability diagnostic.
		const rejected = await runtime.prepare("project:worker", "Say the integration phrase.", ctx, {
			backendId: "pi-subprocess-readonly",
			timeoutMs: 60_000,
		});
		assert.equal(rejected.ok, false);
		if (!rejected.ok) {
			assert.ok(
				rejected.diagnostics.some((d) => d.code === "host.model-not-portable"),
				rejected.diagnostics.map((d) => d.message).join("; "),
			);
		}

		// The in-process backend runs the same extension provider to completion.
		const preparation = await runtime.prepare("project:worker", "Say the integration phrase.", ctx, {
			backendId: "pi-inprocess",
			timeoutMs: 60_000,
		});
		assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.diagnostics.map((d) => d.message).join("; "));
		if (preparation.ok) {
			assert.equal(preparation.prepared.preflight.access.executionBoundary, "shared-user");
			assert.equal(preparation.prepared.preflight.access.enforcement.processIsolation, false);
		}
		const response = await runtime.execute(preparation.prepared, ctx);
		assert.equal(response.status, "completed", response.status === "failed" ? JSON.stringify(response.error) : undefined);
		assert.match(response.output?.text ?? "", /In-process integration passed\./);
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
		modelRegistry.unregisterProvider(PROVIDER);
	}
});
