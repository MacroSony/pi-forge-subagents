import assert from "node:assert/strict";
import test from "node:test";
import { registerForgeSubagentProfilesTool, canonicalProfileId, summarizeProfile, renderEmbeddedSummaryText, type ForgeSubagentProfileSummary } from "../src/tool/forge-subagent-profiles.ts";
import type { ForgeHostSession } from "../src/host/session.ts";
import type { ForgeProfileSummary } from "@zihanw/pi-forge/subagent";
import { resolveSubagentProfilePolicy, type ForgeSubagentSettings } from "../src/config/subagents.ts";

function settings(): ForgeSubagentSettings {
	return {
		timeoutMs: 60_000,
		timeoutSource: "built-in",
		summaryInToolDescription: false,
		profiles: { "project:worker": { enabled: true } },
		profilesSource: { "project:worker": "project" },
		warnings: [],
	};
}

function profileSummary(): ForgeProfileSummary {
	return {
		profileId: "worker",
		scope: "project",
		name: "Worker",
		model: { provider: "test", id: "model-x" },
		thinkingLevel: "high",
		promptStack: "worker",
		usable: true,
		diagnostics: [],
	};
}

test("forge_subagent_profiles is registered and returns enabled profiles", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-profiles-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({ profiles: { "project:worker": { enabled: true } } }), "utf8");
		let captured: any;
		const pi = {
			registerTool: (tool: any) => { captured = tool; },
			getActiveTools: () => ["forge_subagent"],
		} as any;
		const session = {
			listProfiles: async () => [profileSummary()],
		} as unknown as ForgeHostSession;

		registerForgeSubagentProfilesTool(pi, () => session);
		assert.ok(captured);
		assert.equal(captured.name, "forge_subagent_profiles");

		const ctx = {
			cwd,
			isProjectTrusted: () => true,
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
			sessionManager: { getSessionId: () => "s" },
		} as any;
		const result = await captured.execute("call", {}, undefined, undefined, ctx);
		const details = result.details as { profiles: ForgeSubagentProfileSummary[]; status: string };
		assert.equal(details.status, "completed");
		assert.equal(details.profiles.length, 1);
		assert.equal(details.profiles[0]!.id, "project:worker");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("canonicalProfileId and summarizeProfile use scoped selectors", () => {
	const profile = profileSummary();
	const policy = resolveSubagentProfilePolicy(settings(), canonicalProfileId(profile));
	const summary = summarizeProfile(profile, policy);
	assert.equal(summary.id, "project:worker");
	assert.equal(summary.status, "ready");
	assert.equal(summary.backend.id, "pi-subprocess-readonly");
});

test("renderEmbeddedSummaryText returns a bounded enabled-profile summary", () => {
	const profile = profileSummary();
	const policy = resolveSubagentProfilePolicy(settings(), canonicalProfileId(profile));
	const summary = summarizeProfile(profile, policy);
	const text = renderEmbeddedSummaryText([summary]);
	assert.ok(text?.includes("project:worker"));
	assert.ok(text?.includes("backend pi-subprocess-readonly"));
});
