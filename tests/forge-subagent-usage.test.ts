import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForgeNestedUsage } from "@zihanw/pi-forge/subagent";
import { mapForgeSubagentResponseUsage, mapForgeSubagentUsage } from "../src/tool/forge-subagent-usage.ts";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";

const knownUsage = {
	tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, total: 33 },
	requests: { total: 1, cacheKnown: 1, usageKnown: 1 },
	cost: {
		amount: 0.5,
		currency: "USD",
		breakdown: { input: 0.2, output: 0.2, cacheRead: 0.1, cacheWrite: 0 },
	},
};

test("usage mapper promotes only complete usage and accepts the public nested parser", () => {
	const mapped = mapForgeSubagentResponseUsage({ usage: knownUsage });
	assert.deepEqual(mapped.native, {
		input: 10,
		output: 20,
		cacheRead: 3,
		cacheWrite: 0,
		totalTokens: 33,
		cost: { input: 0.2, output: 0.2, cacheRead: 0.1, cacheWrite: 0, total: 0.5 },
	});
	assert.deepEqual(mapped.nested, { schemaVersion: 1, requests: 1, input: 10, output: 20, cacheRead: 3, cacheWrite: 0 });
	assert.deepEqual(parseForgeNestedUsage(mapped.nested), mapped.nested);
	assert.equal(mapped.native?.input + mapped.native?.cacheRead, 13);
});

test("usage mapper keeps unknown and mixed cache coverage nested-only", () => {
	const unknown = mapForgeSubagentUsage({
		tokens: { input: 10, output: 20, total: 30 },
		requests: { total: 2, cacheKnown: 0, usageKnown: 0 },
	});
	assert.equal(unknown.native, undefined);
	assert.deepEqual(unknown.nested, { schemaVersion: 1, requests: 2, input: 10, output: 20 });

	const mixed = mapForgeSubagentUsage({
		tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, total: 33 },
		requests: { total: 2, cacheKnown: 1, usageKnown: 1 },
	});
	assert.equal(mixed.native, undefined);
	assert.deepEqual(mixed.nested, { schemaVersion: 1, requests: 2, input: 10, output: 20 });
});

test("legacy and invalid usage are retained only in response details", () => {
	assert.deepEqual(mapForgeSubagentResponseUsage({ usage: { tokens: { input: 1, output: 2, total: 3 } } }), {});
	assert.deepEqual(mapForgeSubagentUsage({
		tokens: { input: 1, output: 2, cacheRead: 1, total: 4 },
		requests: { total: 1, cacheKnown: 1, usageKnown: 1 },
	}), {});
	assert.deepEqual(mapForgeSubagentUsage({
		tokens: { input: 1, output: 2, cacheRead: 1, cacheWrite: 0, total: 4 },
		requests: { total: 1, cacheKnown: 2, usageKnown: 1 },
	}), {});
});

test("registered forge_subagent emits usage once on final success/failure/cancel and never on progress or approval", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-usage-tool-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({ allowAgentInvocationWithoutApproval: false, profiles: { "project:worker": { enabled: true } } }));
		let captured: any;
		const responses = [
			{ status: "completed", output: { text: "ok", partial: false }, usage: knownUsage },
			{ status: "failed", error: { code: "provider", message: "nope" }, usage: { ...knownUsage, requests: { total: 1, cacheKnown: 0, usageKnown: 0 }, tokens: { input: 10, output: 20, total: 30 } } },
			{ status: "cancelled", reason: "cancelled", output: { text: "partial", partial: true }, usage: { ...knownUsage, requests: { total: 1, cacheKnown: 1, usageKnown: 0 } } },
		];
		const runtime: any = {
			backendIds: () => ["test"],
			descriptors: () => [],
			prepare: async () => ({ ok: true, prepared: {
				plan: {
					profile: { profileId: "project:worker", promptStackId: null, profile: { thinkingLevel: "high" } },
					backendId: "test", model: { provider: "test", id: "model" }, systemPrompt: "system", messages: [], effectiveToolIds: ["read"],
					access: { level: "read-only", executionBoundary: "shared-user", mounts: [] }, executionFingerprint: "fp", conversationFingerprint: "cp",
				}, diagnostics: [],
			} }),
			discard: async () => undefined,
			execute: async (_prepared: unknown, _ctx: unknown, _signal: unknown, onUpdate: (update: unknown) => void) => {
				onUpdate({ phase: "message", message: "working" });
				return responses.shift();
			},
			dispose: async () => undefined,
		};
		registerForgeSubagentTool({ registerTool: (tool: any) => { captured = tool; } } as any, runtime, { sessionProvider: () => ({}) as any });
		const ctx = {
			cwd, hasUI: true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "s" },
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
			ui: { select: async () => "Approve and run", editor: async () => undefined, notify: () => undefined },
		} as any;

		for (const expectedStatus of ["completed", "failed", "cancelled"]) {
			const updates: any[] = [];
			const result = await captured.execute("call", { profileId: "project:worker", task: "x", backend: "test" }, undefined, (partial: any) => updates.push(partial), ctx);
			assert.equal(result.details.status, expectedStatus);
			assert.equal(updates.some((partial) => partial.usage !== undefined), false);
			assert.equal(result.details.response.usage !== undefined, true);
			if (expectedStatus === "completed") {
				assert.deepEqual(result.usage, mapForgeSubagentUsage(knownUsage).native);
				assert.deepEqual(result.details.forgeNestedUsage, mapForgeSubagentUsage(knownUsage).nested);
			} else if (expectedStatus === "failed") {
				assert.equal(result.usage, undefined);
				assert.deepEqual(result.details.forgeNestedUsage, { schemaVersion: 1, requests: 1, input: 10, output: 20 });
			} else {
				assert.equal(result.usage, undefined);
				assert.deepEqual(result.details.forgeNestedUsage, { schemaVersion: 1, requests: 1, input: 10, output: 20, cacheRead: 3, cacheWrite: 0 });
			}
		}

		const rejected = await captured.execute("reject", { profileId: "project:worker", task: "x", backend: "test" }, undefined, undefined, {
			...ctx,
			ui: { select: async () => "Reject", editor: async () => undefined, notify: async () => undefined },
		});
		assert.equal(rejected.usage, undefined);
		assert.equal(rejected.details.response, undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
