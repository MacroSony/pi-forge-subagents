import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SUBAGENT_BACKEND_ID, loadForgeSubagentSettings, projectSubagentsConfigPath, resolveSubagentProfilePolicy } from "../src/config/subagents.ts";

const TEST_GLOBAL_ROOT = join(tmpdir(), `pi-forge-subagents-global-${process.pid}`);
process.env.PI_FORGE_GLOBAL_FORGE_DIR = TEST_GLOBAL_ROOT;

function context(cwd: string, trusted = true) {
	return { cwd, isProjectTrusted: () => trusted } as any;
}

test("optional subagent config loads dedicated subagents.json and resolves policy", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-config-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			backend: "pi-rpc-readonly",
			timeoutMs: 120_000,
			allowAgentInvocationWithoutApproval: true,
			profiles: { "project:worker": { enabled: true, backend: "pi-subprocess-readonly", timeoutMs: 30_000 } },
		}), "utf8");

		const settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(settings.backend, "pi-rpc-readonly");
		assert.equal(settings.timeoutMs, 120_000);
		assert.equal(settings.allowAgentInvocationWithoutApproval, true);

		const policy = resolveSubagentProfilePolicy(settings, "project:worker");
		assert.equal(policy.enabled, true);
		assert.equal(policy.backend.id, "pi-subprocess-readonly");
		assert.equal(policy.timeout.milliseconds, 30_000);

		const unconfigured = resolveSubagentProfilePolicy(settings, "project:other");
		assert.equal(unconfigured.enabled, false);
		assert.equal(unconfigured.backend.id, "pi-rpc-readonly");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("untrusted projects ignore project subagents.json settings", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-untrusted-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({ backend: "pi-rpc-readonly" }), "utf8");
		const settings = loadForgeSubagentSettings(context(cwd, false));
		assert.equal(settings.backend, undefined);
		assert.equal(settings.warnings.some((message) => /not trusted/.test(message)), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("config path helper is stable", () => {
	assert.equal(projectSubagentsConfigPath("/tmp/proj"), "/tmp/proj/.pi/forge/subagents.json");
});

test("optional subagent config parses summaryInToolDescription", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-summary-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			summaryInToolDescription: true,
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");
		const settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(settings.summaryInToolDescription, true);
		assert.equal(settings.summaryInToolDescriptionSource, "project");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("legacy config.json.subagents is a read-only fallback", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-legacy-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({
			subagents: {
				backend: "pi-rpc-readonly",
				timeoutMs: 90_000,
				profiles: { "project:worker": { enabled: true } },
			},
		}), "utf8");
		const settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(settings.backend, "pi-rpc-readonly");
		assert.equal(settings.timeoutMs, 90_000);
		assert.equal(settings.profiles["project:worker"]?.enabled, true);
		assert.equal(settings.warnings.some((message) => /legacy config.json.subagents/.test(message)), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bare project profile keys resolve from canonical selectors", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-bare-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { worker: { enabled: true } },
		}), "utf8");
		const settings = loadForgeSubagentSettings(context(cwd));
		const policy = resolveSubagentProfilePolicy(settings, "project:worker");
		assert.equal(policy.enabled, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("bare keys in global config warn and do not authorize global profiles", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-global-bare-project-"));
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-forge-subagents-global-bare-config-"));
	const previousForge = process.env.PI_FORGE_GLOBAL_FORGE_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_FORGE_DIR = globalRoot;
		mkdirSync(join(globalRoot, ".pi", "forge"), { recursive: true });
		writeFileSync(join(globalRoot, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { reviewer: { enabled: true } },
		}), "utf8");

		const settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(resolveSubagentProfilePolicy(settings, "global:reviewer").enabled, false);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:reviewer").enabled, true);
		assert.equal(
			settings.warnings.some((message) => message.includes('bare global profile key "reviewer"') && message.includes('"global:reviewer"')),
			true,
		);
	} finally {
		if (previousForge === undefined) delete process.env.PI_FORGE_GLOBAL_FORGE_DIR;
		else process.env.PI_FORGE_GLOBAL_FORGE_DIR = previousForge;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalRoot, { recursive: true, force: true });
	}
});

test("profile-level values report per-file provenance (global vs project)", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-provenance-1-"));
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-forge-subagents-provenance-global-"));
	const previousForge = process.env.PI_FORGE_GLOBAL_FORGE_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_FORGE_DIR = globalRoot;
		mkdirSync(join(globalRoot, ".pi", "forge"), { recursive: true });
		// Global defines a scoped global profile and a bare key; project defines
		// its own scoped profile. Each profile-level backend/timeout must report
		// the file it actually came from, not hardcoded "project".
		writeFileSync(join(globalRoot, ".pi", "forge", "subagents.json"), JSON.stringify({
			backend: "pi-rpc-readonly",
			timeoutMs: 90_000,
			profiles: {
				"global:worker": { enabled: true, backend: "pi-rpc-readonly", timeoutMs: 45_000 },
				shared: { enabled: true, backend: "pi-rpc-readonly", timeoutMs: 20_000 },
			},
		}), "utf8");
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			backend: "pi-subprocess-readonly",
			profiles: { "project:worker": { enabled: true, backend: "pi-subprocess-readonly", timeoutMs: 30_000 } },
		}), "utf8");

		const settings = loadForgeSubagentSettings(context(cwd));

		// Project file wins for top-level values.
		assert.equal(settings.backend, "pi-subprocess-readonly");
		assert.equal(settings.backendSource, "project");
		assert.equal(settings.timeoutMs, 90_000, "timeout falls back to the global file value when the project file omits it");
		assert.equal(settings.timeoutSource, "global", "top-level timeout that only exists in the global file reports global");
		assert.equal(settings.profilesSource["global:worker"], "global");
		assert.equal(settings.profilesSource["project:worker"], "project");
		assert.equal(settings.profilesSource["shared"], "global");

		// Global-configured global profile: profile-level values report global.
		const globalPolicy = resolveSubagentProfilePolicy(settings, "global:worker");
		assert.equal(globalPolicy.enabled, true);
		assert.equal(globalPolicy.backend.id, "pi-rpc-readonly");
		assert.equal(globalPolicy.backend.source, "global");
		assert.equal(globalPolicy.timeout.milliseconds, 45_000);
		assert.equal(globalPolicy.timeout.source, "global");

		// Project-configured project profile: profile-level values report project.
		const projectPolicy = resolveSubagentProfilePolicy(settings, "project:worker");
		assert.equal(projectPolicy.backend.id, "pi-subprocess-readonly");
		assert.equal(projectPolicy.backend.source, "project");
		assert.equal(projectPolicy.timeout.milliseconds, 30_000);
		assert.equal(projectPolicy.timeout.source, "project");

		// A bare key defined only in the global file still reports global even
		// when reached through a project-scoped selector.
		const barePolicy = resolveSubagentProfilePolicy(settings, "project:shared");
		assert.equal(barePolicy.enabled, true);
		assert.equal(barePolicy.backend.id, "pi-rpc-readonly");
		assert.equal(barePolicy.backend.source, "global");
		assert.equal(barePolicy.timeout.source, "global");

		// Profile with no profile-level backend/timeout falls back to the
		// top-level value and its provenance (explicit overrides aside).
		const fallbackPolicy = resolveSubagentProfilePolicy(settings, "global:other");
		assert.equal(fallbackPolicy.backend.id, "pi-subprocess-readonly");
		assert.equal(fallbackPolicy.backend.source, "project", "top-level fallback reports the project override source");
		assert.equal(fallbackPolicy.timeout.source, "global");
	} finally {
		if (previousForge === undefined) delete process.env.PI_FORGE_GLOBAL_FORGE_DIR;
		else process.env.PI_FORGE_GLOBAL_FORGE_DIR = previousForge;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalRoot, { recursive: true, force: true });
	}
});
