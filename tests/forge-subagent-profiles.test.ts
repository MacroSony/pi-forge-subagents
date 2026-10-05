import assert from "node:assert/strict";
import test from "node:test";
import { registerForgeSubagentProfilesTool, canonicalProfileId, summarizeProfile, renderEmbeddedSummaryText, renderProfileCatalog, type ForgeSubagentProfileSummary } from "../src/tool/forge-subagent-profiles.ts";
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

test("global host profiles require global-scoped configuration keys", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-global-profile-project-"));
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-forge-subagents-global-profile-config-"));
	const previousForge = process.env.PI_FORGE_GLOBAL_FORGE_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_FORGE_DIR = globalRoot;
		mkdirSync(join(globalRoot, ".pi", "forge"), { recursive: true });
		const configPath = join(globalRoot, ".pi", "forge", "subagents.json");
		writeFileSync(configPath, JSON.stringify({ profiles: { reviewer: { enabled: true } } }), "utf8");
		let captured: any;
		const pi = {
			registerTool: (tool: any) => { captured = tool; },
			getActiveTools: () => ["forge_subagent"],
		} as any;
		const globalProfile = { ...profileSummary(), profileId: "reviewer", scope: "global" as const };
		const session = { listProfiles: async () => [globalProfile] } as unknown as ForgeHostSession;
		registerForgeSubagentProfilesTool(pi, () => session);
		const ctx = {
			cwd,
			isProjectTrusted: () => true,
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
			sessionManager: { getSessionId: () => "s" },
		} as any;

		const bareResult = await captured.execute("call", {}, undefined, undefined, ctx);
		const bareDetails = bareResult.details as { profiles: ForgeSubagentProfileSummary[]; configWarnings: string[] };
		assert.equal(bareDetails.profiles.length, 0);
		assert.equal(bareDetails.configWarnings.some((warning) => /bare global profile key/.test(warning)), true);
		assert.equal(bareDetails.configWarnings.some((warning) => /does not match any host profile/.test(warning)), true);

		writeFileSync(configPath, JSON.stringify({ profiles: { "global:reviewer": { enabled: true } } }), "utf8");
		const scopedResult = await captured.execute("call", {}, undefined, undefined, ctx);
		const scopedDetails = scopedResult.details as { profiles: ForgeSubagentProfileSummary[]; configWarnings: string[] };
		assert.deepEqual(scopedDetails.profiles.map((profile) => profile.id), ["global:reviewer"]);
		assert.equal(scopedDetails.configWarnings.some((warning) => /does not match any host profile/.test(warning)), false);
	} finally {
		if (previousForge === undefined) delete process.env.PI_FORGE_GLOBAL_FORGE_DIR;
		else process.env.PI_FORGE_GLOBAL_FORGE_DIR = previousForge;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalRoot, { recursive: true, force: true });
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

test("profile summaries expose effective model/thinking override permission per profile", () => {
	const profile = profileSummary();
	const base = settings();
	const off = summarizeProfile(profile, resolveSubagentProfilePolicy(base, "project:worker"));
	assert.equal(off.allowAgentModelOverrides, false);
	const on = summarizeProfile(profile, resolveSubagentProfilePolicy({
		...base,
		allowAgentModelOverrides: false,
		profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: true } },
	}, "project:worker"));
	assert.equal(on.allowAgentModelOverrides, true);

	const offText = renderProfileCatalog([off], true);
	assert.match(offText, /Unattended model\/thinking overrides: not allowed for unattended calls/);
	const onText = renderProfileCatalog([on], true);
	assert.match(onText, /Unattended model\/thinking overrides: allowed \(permission only; nothing switches automatically\)/);
	assert.match(onText, /model provider\/id and\/or thinkingLevel/);
	assert.match(onText, /omitted fields use the profile values/);
	assert.match(onText, /unsupported model or thinking level is an error with no fallback/);
	assert.match(onText, /cost and which provider receives prompt data/);
	assert.doesNotMatch(onText, /Unattended model\/thinking overrides: not allowed/);
	assert.match(renderEmbeddedSummaryText([on]) ?? "", /model\/thinking overrides allowed/);
	assert.match(renderEmbeddedSummaryText([off]) ?? "", /model\/thinking overrides off/);
});

test("forge_subagent_profiles discovery shows per-profile override permission from config", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-profiles-overrides-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		const configPath = join(cwd, ".pi", "forge", "subagents.json");
		const second = { ...profileSummary(), profileId: "scribe" };
		let captured: any;
		const pi = { registerTool: (tool: any) => { captured = tool; }, getActiveTools: () => ["forge_subagent"] } as any;
		const session = { listProfiles: async () => [profileSummary(), second] } as unknown as ForgeHostSession;
		registerForgeSubagentProfilesTool(pi, () => session);
		const ctx = { cwd, isProjectTrusted: () => true } as any;
		const run = async () => {
			const result = await captured.execute("call", {}, undefined, undefined, ctx);
			const details = result.details as { profiles: ForgeSubagentProfileSummary[]; configWarnings: string[] };
			return { text: result.content[0].text as string, byId: Object.fromEntries(details.profiles.map((p) => [p.id, p.allowAgentModelOverrides])), details };
		};

		writeFileSync(configPath, JSON.stringify({
			allowAgentModelOverrides: true,
			profiles: { "project:worker": { enabled: true }, "project:scribe": { enabled: true, allowAgentModelOverrides: false } },
		}), "utf8");
		let out = await run();
		assert.deepEqual(out.byId, { "project:worker": true, "project:scribe": false });
		assert.equal((out.text.match(/Unattended model\/thinking overrides: allowed/g) ?? []).length, 1);
		assert.equal((out.text.match(/Unattended model\/thinking overrides: not allowed/g) ?? []).length, 1);

		writeFileSync(configPath, JSON.stringify({
			allowAgentModelOverrides: true,
			profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: null } },
		}), "utf8");
		out = await run();
		assert.deepEqual(out.byId, { "project:worker": false });
		assert.equal(out.details.configWarnings.some((w) => /allowAgentModelOverrides must be boolean; set to false/.test(w)), true);
		assert.match(out.text, /Configuration warning: .*allowAgentModelOverrides must be boolean/);

		writeFileSync(configPath, JSON.stringify({ profiles: { "project:worker": { enabled: true } } }), "utf8");
		out = await run();
		assert.deepEqual(out.byId, { "project:worker": false });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("untrusted discovery lists no profiles and therefore grants no override permission", async () => {
	let captured: any;
	const pi = { registerTool: (tool: any) => { captured = tool; }, getActiveTools: () => [] } as any;
	registerForgeSubagentProfilesTool(pi, () => ({ listProfiles: async () => [profileSummary()] }) as unknown as ForgeHostSession);
	const result = await captured.execute("call", {}, undefined, undefined, { cwd: "/untrusted", isProjectTrusted: () => false } as any);
	assert.equal((result.details as any).status, "disabled");
	assert.deepEqual((result.details as any).profiles, []);
	assert.doesNotMatch(result.content[0].text, /overrides: allowed/);
});
