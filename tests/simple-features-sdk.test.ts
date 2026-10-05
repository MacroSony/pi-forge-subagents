import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context, TranscriptContext, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ForgePrepareRequest, ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import {
	negotiateSubagentTools,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	type AgentProfileSnapshot,
} from "../src/contract/index.ts";
import type { ForgeHostSession } from "../src/host/session.ts";
import { backgroundTasksFor } from "../src/runtime/background-tasks.ts";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import { registerForgeSubagentTaskTool } from "../src/tool/forge-subagent-task.ts";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";

const PROVIDER = "pi-forge-sdk-features-fixture";
const MODEL_ID = "sdk-features-model";
const API = "pi-forge-sdk-features-api";
const PROFILE_ID = "project:worker";

function count(text: string, value: string): number {
	return text.split(value).length - 1;
}

function snapshot(): AgentProfileSnapshot {
	const result: AgentProfileSnapshot = {
		schemaVersion: 1,
		profileId: PROFILE_ID,
		profile: {
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider: PROVIDER, id: MODEL_ID },
			thinkingLevel: "medium",
			promptStack: "worker",
		},
		promptStackId: PROFILE_ID,
		promptStack: { schemaVersion: 1, id: "worker", items: [] },
		dependencies: [],
		profileFingerprint: `sha256:v1:${"0".repeat(64)}`,
		promptStackFingerprint: `sha256:v1:${"0".repeat(64)}`,
	};
	result.profileFingerprint = subagentSourceProfileFingerprint(result.profile);
	result.promptStackFingerprint = subagentPromptStackFingerprint(result.promptStack!);
	return result;
}

type CapturedTool = { execute: (id: string, params: any, signal: AbortSignal | undefined, update: undefined | ((value: any) => void), ctx: any) => Promise<any> };

test("registered SDK tools cover continuation, background ownership, cwd binding, and revocation", async () => {
	const faux = createFauxCore({
		api: API,
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: "SDK feature fixture", reasoning: true }],
		tokensPerSecond: 40,
	});
	const transcripts: Context[] = [];
	const provider = {
		api: API,
		baseUrl: "https://sdk-features.invalid",
		apiKey: "fixture-only",
		streamSimple: (model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) => {
			transcripts.push({
				systemPrompt: getCurrentSystemPrompt(context.messages),
				messages: structuredClone(context.messages),
				...(getCurrentTools(context.messages) ? { tools: getCurrentTools(context.messages).map((tool: any) => ({ name: tool.name })) as any } : {}),
			} as Context);
			return faux.streamSimple(model, context, options);
		},
		models: [{
			id: MODEL_ID,
			name: "SDK feature fixture",
			reasoning: true,
			input: ["text"] as ("text")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		}],
	};
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
	});
	modelRuntime.registerProvider(PROVIDER, provider);
	const modelRegistry = new ModelRegistry(modelRuntime);
	const root = mkdtempSync(join(tmpdir(), "pi-forge-sdk-features-"));
	const target = join(root, "approved-target");
	mkdirSync(join(root, ".pi", "forge"), { recursive: true });
	// Exercise canonical cwd binding even when the host tmpdir has no aliases.
	// macOS runners commonly expose /var/... as /private/var/....
	const targetStorage = join(root, "target-storage");
	mkdirSync(targetStorage);
	symlinkSync(targetStorage, target, process.platform === "win32" ? "junction" : "dir");
	const canonicalTarget = realpathSync(target);
	assert.notEqual(canonicalTarget, target, "fixture must exercise a non-canonical target");
	const toolMarker = join(root, "tool-history.txt");
	writeFileSync(toolMarker, "tool history retained", "utf8");
	const marker = "FULL-MARKER-SDK-FEATURES";
	const configPath = join(root, ".pi", "forge", "subagents.json");
	const writeConfig = (enabled = true, unattended = true, backend = "pi-inprocess") => writeFileSync(configPath, JSON.stringify({
		allowAgentInvocationWithoutApproval: unattended,
		allowedWorkingDirectories: [target],
		profiles: { [PROFILE_ID]: { enabled, backend } },
	}), "utf8");
	writeConfig();

	const profile = snapshot();
	const preparedRequests: ForgePrepareRequest[] = [];
	const hostSession = {
		resolveProfile: async () => ({ snapshot: structuredClone(profile) }),
		prepare: async (request: ForgePrepareRequest) => {
			preparedRequests.push(structuredClone(request));
			const negotiation = negotiateSubagentTools(request.backend.toolCatalog as never, undefined, {
				level: request.access.level, network: request.access.network, allowProcess: request.access.allowProcess,
			} as never);
			const response: ForgePrepareResponse = {
				profileId: PROFILE_ID,
				model: request.backend.model,
				thinkingLevel: "medium",
				systemPrompt: "You are a synthetic worker. Keep the system prompt stable.",
				messages: [{
					role: "user",
					content: [{ type: "text", text: request.task.text }],
					protectedTask: true,
					source: "delegated-task",
				}],
				effectiveToolIds: negotiation.effectiveToolIds,
				effectiveToolNames: negotiation.effectiveToolNames,
				diagnostics: negotiation.diagnostics,
				profileSnapshot: structuredClone(profile),
				preparedAt: "2026-07-14T00:00:00.000Z",
			};
			return response;
		},
	} as unknown as ForgeHostSession;

	let sessionId = "sdk-feature-session";
	let leafId = "main-leaf";
	const ctx = {
		cwd: root,
		hasUI: false,
		isProjectTrusted: () => true,
		modelRegistry,
		signal: undefined,
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => leafId,
			getBranch: () => leafId === "main-leaf" ? [{ id: "main-leaf" }] : [],
		},
		ui: { select: async () => "Reject", editor: async () => undefined, notify: () => undefined },
	} as any;

	let forgeSubagent!: CapturedTool;
	let forgeTask!: CapturedTool;
	const runtime = createForgeSubagentRuntime(() => hostSession, {});
	registerForgeSubagentTool({ registerTool: (tool: CapturedTool) => { forgeSubagent = tool; } } as any, runtime, { sessionProvider: () => hostSession });
	registerForgeSubagentTaskTool({ registerTool: (tool: CapturedTool) => { forgeTask = tool; } } as any, runtime, () => hostSession);

	const call = (params: any, update?: (value: any) => void) => forgeSubagent.execute("sdk-call", params, undefined, update, ctx);
	const taskCall = (params: any) => forgeTask.execute("sdk-task-call", params, undefined, undefined, ctx);
	const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
	const waitForTask = async (id: string) => {
		for (let i = 0; i < 200; i++) {
			const status = await taskCall({ action: "status", id });
			const current = status.details.tasks?.[0]?.status;
			if (current !== "starting" && current !== "running") return status;
			await wait(5);
		}
		throw new Error(`background task did not finish: ${id}`);
	};
	const featureRuntime = runtime.descriptors(ctx).find((descriptor) => descriptor.id === "pi-inprocess") as any;
	const continuationCapability = featureRuntime?.capabilities?.continuation === true;
	// The release combination must exercise continuation. Only an explicit
	// legacy lane (published runtime beta.4) may expect the rejection path.
	const forced = process.env.FORGE_EXPECT_LEGACY_RUNTIME !== "1";
	if (forced) assert.equal(continuationCapability, true, "the release runtime must expose continuation");
	else assert.equal(continuationCapability, false, "legacy runtime beta.4 must report continuation unsupported");

	try {
		// Human rejection is exercised through the registered tool, not by calling
		// the runtime directly. No provider response is allowed to execute.
		writeConfig(true, false);
		ctx.hasUI = true;
		const denied = await call({ profileId: PROFILE_ID, task: "approval must deny", backend: "pi-inprocess" });
		assert.equal(denied.details.status, "cancelled");
		assert.equal(denied.details.approval.approved, false);
		writeConfig();
		ctx.hasUI = false;

		if (forced) {
			// The first retained run includes an actual read tool turn. The host
			// compiler receives dynamic protected task text on every preparation.
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: toolMarker }, { id: "child-read-once" })),
				fauxAssistantMessage(`first ${marker}`),
				fauxAssistantMessage("continued FULL marker exactly once"),
			]);
			const first = await call({ profileId: PROFILE_ID, task: marker, backend: "pi-inprocess", keepContext: true });
			assert.equal(first.details.status, "completed", JSON.stringify(first));
			const continuationId = first.details.response?.continuationId;
			assert.equal(typeof continuationId, "string");
			assert.equal(first.details.response?.output?.text, `first ${marker}`);
			const beforeContinuation = preparedRequests.length;

			// Revocation after retention is denied before the old child can run.
			writeConfig(false);
			const revoked = await call({ profileId: PROFILE_ID, task: "must be denied after retain", backend: "pi-inprocess", continueId: continuationId });
			assert.equal(revoked.details.status, "failed");
			assert.match(revoked.content[0].text, /not enabled/);
			assert.equal(preparedRequests.length, beforeContinuation);
			writeConfig();

			const continued = await call({ profileId: PROFILE_ID, task: "CONTINUE-TASK-SDK-FEATURES", backend: "pi-inprocess", continueId: continuationId });
			assert.equal(continued.details.status, "completed", JSON.stringify(continued));
			assert.match(continued.details.response.output.text, /continued FULL marker/);
			assert.equal(continued.details.response.continuationId, continuationId);
			const continuationTranscript = transcripts.find((entry) => JSON.stringify(entry).includes("CONTINUE-TASK-SDK-FEATURES"));
			assert.ok(continuationTranscript, "provider must receive the retained transcript");
			const serialized = JSON.stringify(continuationTranscript);
			assert.equal(continuationTranscript.messages.filter((message: any) => message.role === "user" && JSON.stringify(message.content).includes(marker)).length, 1, "the first protected task is retained exactly once");
			assert.equal(continuationTranscript.messages.filter((message: any) => message.role === "assistant" && JSON.stringify(message.content).includes(`first ${marker}`)).length, 1, "original assistant reply also remains intact");
			assert.equal(continuationTranscript.messages.filter((message: any) => message.role === "assistant" && message.content.some((part: any) => part.type === "toolCall" && part.id === "child-read-once")).length, 1, "prior tool call exactly once");
			assert.equal(continuationTranscript.messages.filter((message: any) => message.role === "toolResult" && message.toolCallId === "child-read-once").length, 1, "matching tool result exactly once");
			assert.equal(continued.details.response.usage.requests.total, 1, "continuation usage is new request only");
			assert.equal(first.details.response.usage.requests.total, 2, "first run includes its read-tool loop");
			assert.equal(count(serialized, "CONTINUE-TASK-SDK-FEATURES"), 1, "the continuation task is appended exactly once");

			const released = await taskCall({ action: "release", id: continuationId });
			assert.equal(released.details.action, "release");
			const releasedAgain = await taskCall({ action: "release", id: continuationId });
			assert.equal(releasedAgain.details.status, "failed");

			// An interactive continuation inherits its retained backend when the
			// original run overrode the profile default; callers need not repeat it.
			writeConfig(true, false, "pi-bwrap-write");
			ctx.hasUI = true;
			ctx.ui.select = async () => "Approve and run";
			faux.setResponses([fauxAssistantMessage("interactive first"), fauxAssistantMessage("interactive continued")]);
			const interactive = await call({ profileId: PROFILE_ID, task: "interactive retained", backend: "pi-inprocess", keepContext: true });
			assert.equal(interactive.details.status, "completed", JSON.stringify(interactive));
			const interactiveId = interactive.details.response.continuationId;
			const inherited = await call({ profileId: PROFILE_ID, task: "inherit backend", continueId: interactiveId });
			assert.equal(inherited.details.status, "completed", JSON.stringify(inherited));
			assert.equal(inherited.details.response.continuationId, interactiveId);
			await taskCall({ action: "release", id: interactiveId });
			ctx.hasUI = false;
			writeConfig();
		} else {
			faux.setResponses([fauxAssistantMessage("beta.4 continuation probe")]);
			const unsupported = await call({ profileId: PROFILE_ID, task: marker, backend: "pi-inprocess", keepContext: true });
			assert.equal(unsupported.details.status, "failed");
			assert.match(unsupported.content[0].text, /continuation/i);
			assert.match(unsupported.content[0].text, /supported only by the new|updated runtime/i);
		}

		// A parent and an approved external target use different generations and
		// therefore different execution fingerprints. Updates expose the actual
		// backend tool surface and working directory.
		faux.setResponses([fauxAssistantMessage("parent fingerprint run")]);
		const parent = await call({ profileId: PROFILE_ID, task: "parent fingerprint", backend: "pi-inprocess" });
		assert.equal(parent.details.status, "completed", JSON.stringify(parent));
		const parentFingerprint = parent.details.approval.executionFingerprint;
		faux.setResponses([fauxAssistantMessage("target fingerprint run")]);
		const updates: any[] = [];
		const external = await call({ profileId: PROFILE_ID, task: "approved target fingerprint", backend: "pi-inprocess", cwd: target }, (update) => updates.push(update));
		assert.equal(external.details.status, "completed", JSON.stringify(external));
		assert.notEqual(external.details.approval.executionFingerprint, parentFingerprint);
		const externalUsage = external.details.response?.usage;
		assert.ok(externalUsage && externalUsage.tokens, "each run must expose its own usage delta");
		if (externalUsage?.requests) assert.equal(externalUsage.requests.total, 1, "usage is per run, not cumulative");
		const backendUpdates = updates.flatMap((update) => update.details?.progress ?? []);
		assert.ok(backendUpdates.some((update: any) => update.details?.workingDirectory === canonicalTarget), "backend must bind the canonical approved target cwd");
		assert.ok(backendUpdates.some((update: any) => Array.isArray(update.details?.effectiveToolNames) && update.details.effectiveToolNames.includes("read")), "backend tools must be visible in real execution updates");
		assert.ok(preparedRequests.some((request) => request.task.text === "approved target fingerprint" && request.backend.toolCatalog.length > 0));

		// Background result collection is a one-time accounting claim. beta.4
		// truthfully has no coverage metadata; the forced runtime must provide it.
		faux.setResponses([fauxAssistantMessage("background result")]);
		const launched = await call({ profileId: PROFILE_ID, task: "background basics", backend: "pi-inprocess", background: true });
		assert.equal(launched.details.background, true);
		const runId = launched.details.runId;
		assert.equal(typeof runId, "string");
		const status = await taskCall({ action: "status", id: runId });
		assert.equal(status.details.tasks.length, 1);
		const finished = await waitForTask(runId);
		const firstResult = await taskCall({ action: "result", id: runId });
		assert.equal(firstResult.details.usageCredited, true);
		assert.ok(firstResult.details.response?.usage?.tokens, "the collected result retains the per-run usage delta");
		assert.equal(firstResult.details.task.collected, true);
		const secondResult = await taskCall({ action: "result", id: runId });
		assert.equal(secondResult.details.usageCredited, false);
		assert.equal(secondResult.usage, undefined);
		assert.equal(secondResult.details.forgeNestedUsage, undefined);
		if (forced || firstResult.details.forgeNestedUsage !== undefined) {
			assert.equal(typeof firstResult.usage, "object");
			assert.equal(firstResult.details.forgeNestedUsage.requests, 1);
		} else {
			assert.equal(firstResult.usage, undefined, "beta.4 must not invent native usage without coverage metadata");
		}
		assert.equal(finished.details.tasks[0].status, "completed");

		// A completed result cannot be collected from an unrelated branch, and a
		// task is not even visible to another parent session.
		faux.setResponses([fauxAssistantMessage("branch ownership")]);
		const branchLaunch = await call({ profileId: PROFILE_ID, task: "branch ownership", backend: "pi-inprocess", background: true });
		const branchRunId = branchLaunch.details.runId;
		await waitForTask(branchRunId);
		leafId = "other-leaf";
		const branchDenied = await taskCall({ action: "result", id: branchRunId });
		assert.equal(branchDenied.details.status, "failed");
		assert.match(branchDenied.content[0].text, /launch branch/);
		leafId = "main-leaf";
		const branchCollected = await taskCall({ action: "result", id: branchRunId });
		assert.equal(branchCollected.details.usageCredited, true);

		faux.setResponses([fauxAssistantMessage("session ownership")]);
		const sessionLaunch = await call({ profileId: PROFILE_ID, task: "session ownership", backend: "pi-inprocess", background: true });
		const sessionRunId = sessionLaunch.details.runId;
		await waitForTask(sessionRunId);
		sessionId = "different-parent-session";
		const foreignStatus = await taskCall({ action: "status" });
		assert.equal(foreignStatus.content[0].text, "No background tasks in this parent session.");
		const foreignResult = await taskCall({ action: "result", id: sessionRunId });
		assert.equal(foreignResult.details.status, "failed");
		sessionId = "sdk-feature-session";
		await taskCall({ action: "cancel", id: sessionRunId });

		// Cancellation and parent disposal terminate actual handles. Clearing the
		// manager is the same lifecycle operation used by the extension shutdown.
		faux.setResponses([fauxAssistantMessage("x".repeat(8_000))]);
		const cancelLaunch = await call({ profileId: PROFILE_ID, task: "cancel me", backend: "pi-inprocess", background: true });
		const cancelId = cancelLaunch.details.runId;
		await taskCall({ action: "cancel", id: cancelId });
		const cancelled = await waitForTask(cancelId);
		assert.equal(cancelled.details.tasks[0].status, "cancelled");

		faux.setResponses([fauxAssistantMessage("dispose me")]);
		const disposeLaunch = await call({ profileId: PROFILE_ID, task: "dispose me", backend: "pi-inprocess", background: true });
		const disposeId = disposeLaunch.details.runId;
		await runtime.dispose();
		await wait(10);
		assert.equal((await taskCall({ action: "status", id: disposeId })).details.tasks[0].status, "cancelled");
		backgroundTasksFor(runtime).clear();
		assert.equal((await taskCall({ action: "status" })).content[0].text, "No background tasks in this parent session.");
	} finally {
		backgroundTasksFor(runtime).clear();
		await runtime.dispose();
		modelRuntime.unregisterProvider(PROVIDER);
		rmSync(root, { recursive: true, force: true });
	}
});
