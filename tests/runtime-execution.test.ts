import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { negotiateSubagentTools, subagentPromptStackFingerprint, subagentSourceProfileFingerprint, type AgentProfileSnapshot, type ForgePrepareRequest, type ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import { DeterministicFakeBackend } from "@zihanw/pi-subagent-runtime/testing";
import { createForgeSubagentRuntime, type ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
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
				model: { provider: "test-provider", id: "model-x" },
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

function fakeCtx(): any {
	return {
		cwd: "/tmp/proj",
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "session-1" },
		signal: undefined,
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			find: () => undefined,
			hasConfiguredAuth: () => false,
		},
	};
}

test("runtime executes the full chain: preflight -> seal -> prepare -> execute", async () => {
	const fakeBackend = new DeterministicFakeBackend({ id: "fake-test-backend", fidelity: "backend-assisted" });
	const runtime: ForgeSubagentRuntime = createForgeSubagentRuntime(fakeSession, {
		builtInBackends: false,
		extraBackends: [fakeBackend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});
	const ctx = fakeCtx();
	const cwd = ctx.cwd as string;
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
		profiles: { "project:worker": { enabled: true } },
	}), "utf8");
	try {
		const preparation = await runtime.prepare("project:worker", "Review the patch.", ctx, {
			backendId: "fake-test-backend",
			timeoutMs: 60_000,
		});
		assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.diagnostics.map((d) => d.message).join("; "));
		const prepared = preparation.prepared;
		assert.equal(prepared.plan.profile.profileId, "project:worker");
		assert.ok(prepared.plan.conversationFingerprint);
		assert.ok(prepared.plan.executionFingerprint);
		assert.match(prepared.plan.systemPrompt, /focused reviewer/);

		fakeBackend.executionMode = "completed";
		const response = await runtime.execute(prepared, ctx);
		assert.equal(response.status, "completed");
		if (response.status === "completed") {
			assert.equal(typeof response.output?.text, "string");
			assert.equal(response.executionFingerprint, prepared.plan.executionFingerprint);
		}
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
