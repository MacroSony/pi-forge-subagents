import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ForgePrepareRequest, ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import {
	negotiateSubagentTools,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	type AgentProfileSnapshot,
} from "../src/contract/index.ts";
import type { ForgeHostSession } from "../src/host/session.ts";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";

const PROVIDER = "pi-forge-sdk-usage-fixture";
const MODEL_ID = "sdk-usage-model";
const API = "pi-forge-sdk-usage-api";

const CHILD_RECEIPT = {
	input: 11,
	output: 7,
	cacheRead: 5,
	cacheWrite: 2,
	totalTokens: 25,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
};
const EXPECTED_NATIVE = CHILD_RECEIPT;
const EXPECTED_NESTED = {
	schemaVersion: 1 as const,
	requests: 1,
	input: 11,
	output: 7,
	cacheRead: 5,
	cacheWrite: 2,
};

/** Keep the provider synthetic, but make its persisted receipts deterministic. */
function streamWithSyntheticReceipt(
	faux: ReturnType<typeof createFauxCore>,
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
) {
	const source = faux.streamSimple(model, context, options);
	const target = createAssistantMessageEventStream();
	void (async () => {
		for await (const event of source) {
			if (event.type === "done") {
				const message = { ...event.message, usage: structuredClone(CHILD_RECEIPT) };
				target.push({ type: "done", reason: event.reason, message });
				target.end(message);
				return;
			}
			target.push(event);
		}
	})().catch((error: unknown) => target.end({
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: structuredClone(CHILD_RECEIPT),
			stopReason: "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
	}));
	return target;
}

function makeSnapshot(provider: string): AgentProfileSnapshot {
	const snapshot: AgentProfileSnapshot = {
		schemaVersion: 1,
		profileId: "project:worker",
		profile: {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider, id: MODEL_ID },
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
	return snapshot;
}

async function loadSummarizeSessionCacheUsage(): Promise<(entries: readonly unknown[]) => any> {
	const publicForge = await import("@zihanw/pi-forge");
	const exported = (publicForge as unknown as { summarizeSessionCacheUsage?: unknown }).summarizeSessionCacheUsage;
	if (typeof exported === "function") return exported as (entries: readonly unknown[]) => any;
	// The read-only summarizer is intentionally not a public package export.
	// Cross-package verification uses the sibling checkout, never copies its logic.
	const sourceForge = await import("../../pi-forge/src/session-usage.ts");
	return sourceForge.summarizeSessionCacheUsage;
}

test("registered forge_subagent survives the real SDK loop and JSONL reload with usage", async () => {
	const faux = createFauxCore({
		api: API,
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: "SDK usage fixture", reasoning: true }],
	});
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("forge_subagent", {
			profileId: "project:worker",
			task: "Return the nested receipt phrase.",
			backend: "pi-inprocess",
		}, { id: "parent-tool-call" })),
		fauxAssistantMessage("Nested receipt phrase."),
		fauxAssistantMessage("Parent completed the delegated task."),
	]);

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(PROVIDER, {
		api: API,
		baseUrl: "https://sdk-usage.invalid",
		apiKey: "synthetic-key",
		streamSimple: (model, context, options) => streamWithSyntheticReceipt(faux, model, context, options),
		models: [{
			id: MODEL_ID,
			name: "SDK usage fixture",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		}],
	});

	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-sdk-usage-"));
	const sessionDir = join(cwd, "sessions");
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
		allowAgentInvocationWithoutApproval: true,
		profiles: { "project:worker": { enabled: true, backend: "pi-inprocess" } },
	}), "utf8");

	const snapshot = makeSnapshot(PROVIDER);
	const hostSession = {
		resolveProfile: async () => ({ snapshot }),
		prepare: async (request: ForgePrepareRequest) => {
			const negotiation = negotiateSubagentTools(request.backend.toolCatalog as never, undefined, {
				level: request.access.level,
				network: request.access.network,
				allowProcess: request.access.allowProcess,
			} as never);
			const response: ForgePrepareResponse = {
				profileId: "project:worker",
				model: request.backend.model,
				thinkingLevel: "medium",
				systemPrompt: "You are a nested synthetic worker.",
				messages: [{ role: "user", content: [{ type: "text", text: "Return the nested receipt phrase." }], protectedTask: true, source: "delegated-task" }],
				effectiveToolIds: negotiation.effectiveToolIds,
				effectiveToolNames: negotiation.effectiveToolNames,
				diagnostics: negotiation.diagnostics,
				profileSnapshot: snapshot,
				preparedAt: "2026-07-14T00:00:00.000Z",
			};
			return response;
		},
	} as unknown as ForgeHostSession;

	const runtime = createForgeSubagentRuntime(() => hostSession, {});
	const sessionManager = SessionManager.create(cwd, sessionDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: join(cwd, "agent"),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		systemPrompt: "You are the parent synthetic agent. Delegate once using forge_subagent.",
		extensionFactories: [
			(pi) => {
				registerForgeSubagentTool(pi, runtime, { sessionProvider: () => hostSession });
			},
		],
	});
	await resourceLoader.reload();

	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const created = await createAgentSession({
			cwd,
			agentDir: join(cwd, "agent"),
			modelRuntime,
			model: faux.getModel(),
			thinkingLevel: "medium",
			resourceLoader,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
			tools: ["forge_subagent"],
		});
		session = created.session;
		await session.prompt("Delegate the task and report the result.");
		await session.waitForIdle();

		assert.equal(faux.state.callCount, 3, "parent first turn, nested runtime, parent final turn");
		assert.match(session.getLastAssistantText() ?? "", /Parent completed/);

		const entries = sessionManager.getEntries();
		const toolResults = entries.filter((entry: any) => entry.type === "message" && entry.message?.role === "toolResult");
		assert.equal(toolResults.length, 1, "the SDK must persist exactly one forge_subagent tool result");
		const toolResult = (toolResults[0] as any).message;
		assert.equal(toolResult.isError, false);
		assert.equal(toolResult.details.status, "completed");
		assert.equal(typeof toolResult.details.response?.usage, "object", "legacy runtime usage remains visible in response details");

		const forced = process.env.FORGE_EXPECT_RUNTIME_USAGE === "1" ||
			toolResult.details.response.usage.requests !== undefined;
		if (forced) {
			assert.deepEqual(toolResult.usage, EXPECTED_NATIVE);
			assert.deepEqual(toolResult.details.forgeNestedUsage, EXPECTED_NESTED);
		} else {
			// beta.4 has no coverage metadata: do not promote ambiguous usage into
			// Pi native totals or Forge nested attribution.
			assert.equal(toolResult.usage, undefined);
			assert.equal(toolResult.details.forgeNestedUsage, undefined);
		}

		const stats = session.getSessionStats();
		assert.equal(stats.toolResults, 1);
		assert.equal(stats.toolCalls, 1);
		assert.ok(Math.abs(stats.cost - CHILD_RECEIPT.cost.total * (forced ? 3 : 2)) < 1e-12);
		if (forced) {
			assert.deepEqual(stats.tokens, { input: 33, output: 21, cacheRead: 15, cacheWrite: 6, total: 75 });
		} else {
			assert.deepEqual(stats.tokens, { input: 22, output: 14, cacheRead: 10, cacheWrite: 4, total: 50 });
		}

		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile);
		const reopened = SessionManager.open(sessionFile!);
		const reopenedResults = reopened.getEntries().filter((entry: any) => entry.type === "message" && entry.message?.role === "toolResult");
		assert.equal(reopenedResults.length, 1);
		assert.deepEqual((reopenedResults[0] as any).message.usage, toolResult.usage);
		assert.deepEqual((reopenedResults[0] as any).message.details.forgeNestedUsage, toolResult.details.forgeNestedUsage);

		const summarize = await loadSummarizeSessionCacheUsage();
		const view = summarize(reopened.getBranch());
		assert.deepEqual(view.main.session, { requests: 2, input: 22, output: 14, cacheRead: 10, cacheWrite: 4 });
		if (forced) {
			assert.deepEqual(view.nested.session, { requests: 1, input: 11, output: 7, cacheRead: 5, cacheWrite: 2, calls: 1, cacheUnknownCalls: 0, invalidCalls: 0 });
			assert.deepEqual(view.main.session, { requests: 2, input: 22, output: 14, cacheRead: 10, cacheWrite: 4 }, "nested usage stays out of main totals");
		} else {
			assert.deepEqual(view.nested.session, { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cacheUnknownCalls: 0, invalidCalls: 0 });
		}
	} finally {
		session?.dispose();
		await runtime.dispose();
		modelRuntime.unregisterProvider(PROVIDER);
		rmSync(cwd, { recursive: true, force: true });
	}
});
