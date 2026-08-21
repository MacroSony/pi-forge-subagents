import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgePrepareRequest, ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import { negotiateSubagentTools, subagentPromptStackFingerprint, subagentSourceProfileFingerprint, type AgentProfileSnapshot, type SubagentDiagnostic } from "../src/contract/index.ts";
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

function fakeSession(hostDiagnostics?: SubagentDiagnostic[], snapshotOverride?: unknown): ForgeHostSession {
	const session = {
		resolveProfile: async () => ({ snapshot: snapshotOverride ?? SNAPSHOT }),
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
				diagnostics: hostDiagnostics ?? negotiation.diagnostics,
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

test("runtime carries a per-run model override into the sealed plan", async () => {
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
			model: { provider: "override-provider", id: "override-model" },
		});
		assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.diagnostics.map((d) => d.message).join("; "));
		if (preparation.ok) {
			assert.equal(preparation.prepared.plan.model.provider, "override-provider");
			assert.equal(preparation.prepared.plan.model.id, "override-model");
		}
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("host preparation diagnostics are reported exactly once", async () => {
	const hostDiagnostics: SubagentDiagnostic[] = [
		{ level: "info", code: "host.prepare.note", message: "host note one" },
		{ level: "warning", code: "host.prepare.warn", message: "host warning two" },
	];
	const fakeBackend = new DeterministicFakeBackend({ id: "fake-test-backend", fidelity: "backend-assisted" });
	const runtime: ForgeSubagentRuntime = createForgeSubagentRuntime(() => fakeSession(hostDiagnostics), {
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
		const reported = preparation.prepared.diagnostics;
		for (const host of hostDiagnostics) {
			const matches = reported.filter((d) => d.code === host.code && d.message === host.message);
			assert.equal(matches.length, 1, `host diagnostic ${host.code}:${host.message} must appear exactly once (found ${matches.length})`);
		}
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("generation replacement serializes disposal before preparing with the new generation", async () => {
	const inner = new DeterministicFakeBackend({ id: "fake-test-backend", fidelity: "backend-assisted" });
	let releaseDispose!: () => void;
	const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve; });
	const backend = {
		descriptor: inner.descriptor,
		preflight: (input: any) => inner.preflight(input),
		prepare: (input: any, context: any) => inner.prepare(input, context),
		start: (input: any, context: any) => inner.start(input, context),
		discard: (preparation: any) => inner.discard(preparation),
		dispose: () => disposeGate,
	} as any;
	const runtime: ForgeSubagentRuntime = createForgeSubagentRuntime(fakeSession, {
		builtInBackends: false,
		extraBackends: [backend],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});
	const ctxA = fakeCtx();
	ctxA.cwd = "/tmp/gen-a";
	const ctxB = fakeCtx();
	ctxB.cwd = "/tmp/gen-b";
	for (const ctx of [ctxA, ctxB]) {
		mkdirSync(join(ctx.cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(ctx.cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");
	}
	try {
		const first = await runtime.prepare("project:worker", "Review the patch.", ctxA, { backendId: "fake-test-backend", timeoutMs: 60_000 });
		assert.equal(first.ok, true, first.ok ? undefined : first.diagnostics.map((d) => d.message).join("; "));
		assert.equal(inner.preflightCalls.length, 1);

		// A different cwd forces a generation replacement; the replaced
		// generation's disposal must gate the fresh generation's preflight.
		const secondPromise = runtime.prepare("project:worker", "Review the patch.", ctxB, { backendId: "fake-test-backend", timeoutMs: 60_000 });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(inner.preflightCalls.length, 1, "fresh generation preflight must wait for replaced generation disposal");

		releaseDispose();
		const second = await secondPromise;
		assert.equal(second.ok, true, second.ok ? undefined : second.diagnostics.map((d) => d.message).join("; "));
		assert.equal(inner.preflightCalls.length, 2, "fresh generation preflight runs after replaced generation disposal settles");
	} finally {
		releaseDispose();
		await runtime.dispose();
		rmSync(ctxA.cwd as string, { recursive: true, force: true });
		rmSync(ctxB.cwd as string, { recursive: true, force: true });
	}
});

test("prepare fails fast on a malformed host snapshot before touching backends", async () => {
	const malformed = { schemaVersion: 1, profileId: "not a selector", profile: { model: "nope" } };
	const inner = new DeterministicFakeBackend({ id: "fake-test-backend", fidelity: "backend-assisted" });
	let preflightCalls = 0;
	const backend = {
		descriptor: inner.descriptor,
		preflight: (input: any) => { preflightCalls += 1; return inner.preflight(input); },
		prepare: (input: any, context: any) => inner.prepare(input, context),
		start: (input: any, context: any) => inner.start(input, context),
		discard: (preparation: any) => inner.discard(preparation),
	};
	const runtime: ForgeSubagentRuntime = createForgeSubagentRuntime(() => fakeSession(undefined, malformed), {
		builtInBackends: false,
		extraBackends: [backend as any],
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
		assert.equal(preparation.ok, false);
		if (!preparation.ok) {
			assert.ok(preparation.diagnostics.some((d) => d.code?.startsWith("snapshot.")),
				`expected snapshot.* diagnostics, got: ${preparation.diagnostics.map((d) => d.code).join(", ")}`);
		}
		assert.equal(preflightCalls, 0, "backend preflight must not run for an invalid snapshot");
	} finally {
		await runtime.dispose();
		rmSync(cwd, { recursive: true, force: true });
	}
});
