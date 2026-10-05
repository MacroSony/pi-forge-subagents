import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_SUBAGENT_BACKEND_ID,
	globalLegacyForgeConfigPath,
	globalSubagentsConfigPath,
	loadForgeSubagentSettings,
	projectSubagentsConfigPath,
	resolveSubagentProfilePolicy,
} from "../src/config/subagents.ts";

const TEST_GLOBAL_ROOT = join(tmpdir(), `pi-forge-subagents-global-${process.pid}`);
process.env.PI_FORGE_GLOBAL_FORGE_DIR = TEST_GLOBAL_ROOT;

function context(cwd: string, trusted = true) {
	return { cwd, isProjectTrusted: () => trusted } as any;
}

test("PI_FORGE_GLOBAL_DIR points directly to the Forge directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-global-dir-project-"));
	const forgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-global-dir-forge-"));
	const previous = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = forgeDir;
		writeFileSync(join(forgeDir, "subagents.json"), JSON.stringify({
			profiles: { "global:image-viewer": { enabled: true } },
		}), "utf8");

		assert.equal(globalSubagentsConfigPath(), join(forgeDir, "subagents.json"));
		assert.equal(globalLegacyForgeConfigPath(), join(forgeDir, "config.json"));
		assert.equal(resolveSubagentProfilePolicy(loadForgeSubagentSettings(context(cwd)), "global:image-viewer").enabled, true);
	} finally {
		if (previous === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(forgeDir, { recursive: true, force: true });
	}
});

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
	const root = join(tmpdir(), "proj");
	assert.equal(projectSubagentsConfigPath(root), join(root, ".pi", "forge", "subagents.json"));
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

test("allowAgentInvocationWithoutApproval: global true + project absent/true/false/nonbooleans", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-approval-project-"));
	const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-approval-global-"));
	const previousGlobalDir = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = globalForgeDir;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });

		// Global sets allowAgentInvocationWithoutApproval: true
		writeFileSync(join(globalForgeDir, "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: true,
		}), "utf8");

		// 1. Project omits allowAgentInvocationWithoutApproval -> inherits true
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			timeoutMs: 30_000,
		}), "utf8");
		let settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(settings.allowAgentInvocationWithoutApproval, true);

		// 2. Project explicitly sets true -> true
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: true,
		}), "utf8");
		settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(settings.allowAgentInvocationWithoutApproval, true);

		// 3. Project explicitly sets false -> false
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: false,
		}), "utf8");
		settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(settings.allowAgentInvocationWithoutApproval, false);

		// 4. Project explicitly sets nonbooleans: null, 'false', 'true', numbers, objects, arrays
		// MUST set effective field false at that config layer and warn, not silently retain previous layer true.
		const nonBooleans: unknown[] = [null, "false", "true", 0, 1, 42, {}, [], ["unexpected"]];
		for (const val of nonBooleans) {
			writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
				allowAgentInvocationWithoutApproval: val,
			}), "utf8");
			settings = loadForgeSubagentSettings(context(cwd));
			assert.equal(
				settings.allowAgentInvocationWithoutApproval,
				false,
				`Expected false for non-boolean ${JSON.stringify(val)}, got ${settings.allowAgentInvocationWithoutApproval}`,
			);
			assert.equal(
				settings.warnings.some((w) => w.includes("project allowAgentInvocationWithoutApproval must be boolean; set to false")),
				true,
				`Expected warning for non-boolean ${JSON.stringify(val)}`,
			);
		}
	} finally {
		if (previousGlobalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalForgeDir, { recursive: true, force: true });
	}
});

test("allowAgentInvocationWithoutApproval: legacy true then dedicated invalid sets false and warns", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-legacy-approval-"));
	const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-legacy-approval-global-"));
	const previousGlobalDir = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = globalForgeDir;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });

		// Project legacy config.json sets allowAgentInvocationWithoutApproval: true
		writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({
			subagents: {
				allowAgentInvocationWithoutApproval: true,
			},
		}), "utf8");

		// Dedicated subagents.json sets invalid non-boolean value
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: "invalid",
		}), "utf8");

		const settings = loadForgeSubagentSettings(context(cwd));
		assert.equal(settings.allowAgentInvocationWithoutApproval, false);
		assert.equal(
			settings.warnings.some((w) => w.includes("project allowAgentInvocationWithoutApproval must be boolean; set to false")),
			true,
		);
	} finally {
		if (previousGlobalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalForgeDir, { recursive: true, force: true });
	}
});

test("allowAgentInvocationWithoutApproval: invalid global overridden by valid higher-priority project true", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-override-project-"));
	const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-override-global-"));
	const previousGlobalDir = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = globalForgeDir;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });

		// Global has invalid non-boolean
		writeFileSync(join(globalForgeDir, "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: "invalid",
		}), "utf8");

		// Project (trusted) has valid true
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: true,
		}), "utf8");

		const settings = loadForgeSubagentSettings(context(cwd, true));
		// Higher-priority project true overrides global invalid
		assert.equal(settings.allowAgentInvocationWithoutApproval, true);
		// Global warning is still recorded
		assert.equal(
			settings.warnings.some((w) => w.includes("global allowAgentInvocationWithoutApproval must be boolean; set to false")),
			true,
		);
	} finally {
		if (previousGlobalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalForgeDir, { recursive: true, force: true });
	}
});

test("allowAgentInvocationWithoutApproval: untrusted project ignored as before", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-untrusted-approval-"));
	const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-untrusted-approval-global-"));
	const previousGlobalDir = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = globalForgeDir;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });

		// Global has true
		writeFileSync(join(globalForgeDir, "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: true,
		}), "utf8");

		for (const value of [false, "false", null]) {
			writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
				allowAgentInvocationWithoutApproval: value,
			}), "utf8");
			const settings = loadForgeSubagentSettings(context(cwd, false));
			// Untrusted project settings are not applied, even to revoke a global value.
			// The separate execution trust gate still prevents delegation from this project.
			assert.equal(settings.allowAgentInvocationWithoutApproval, true);
			assert.equal(settings.warnings.some((w) => /not trusted/.test(w)), true);
			assert.equal(settings.warnings.some((w) => w.includes("must be boolean")), false);
		}
	} finally {
		if (previousGlobalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalForgeDir, { recursive: true, force: true });
	}
});


test("malformed whole config files retain the documented ignore-with-warning behavior", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-invalid-file-project-"));
	const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-invalid-file-global-"));
	const previousGlobalDir = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = globalForgeDir;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(globalForgeDir, "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: true,
		}), "utf8");
		const projectPath = projectSubagentsConfigPath(cwd);
		for (const text of ["{", "[]", "null"]) {
			writeFileSync(projectPath, text, "utf8");
			const settings = loadForgeSubagentSettings(context(cwd));
			assert.equal(settings.allowAgentInvocationWithoutApproval, true);
			assert.equal(settings.warnings.some((w) => w.includes(projectPath) && /ignored/.test(w)), true);
		}
	} finally {
		if (previousGlobalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalForgeDir, { recursive: true, force: true });
	}
});

function withModelOverrideConfig(globalConfig: unknown, projectConfig: unknown, trusted: boolean, run: (settings: ReturnType<typeof loadForgeSubagentSettings>) => void): void {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-model-override-project-"));
	const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-model-override-global-"));
	const previousGlobalDir = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = globalForgeDir;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		if (globalConfig !== undefined) writeFileSync(join(globalForgeDir, "subagents.json"), JSON.stringify(globalConfig), "utf8");
		if (projectConfig !== undefined) writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify(projectConfig), "utf8");
		run(loadForgeSubagentSettings(context(cwd, trusted)));
	} finally {
		if (previousGlobalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalForgeDir, { recursive: true, force: true });
	}
}

test("allowAgentModelOverrides defaults to false for top level and every resolved profile", () => {
	withModelOverrideConfig({ profiles: { "global:reviewer": { enabled: true } } }, { profiles: { "project:worker": { enabled: true } } }, true, (settings) => {
		assert.equal(settings.allowAgentModelOverrides, false);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:worker").allowAgentModelOverrides, false);
		assert.equal(resolveSubagentProfilePolicy(settings, "global:reviewer").allowAgentModelOverrides, false);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:unconfigured").allowAgentModelOverrides, false);
		assert.equal(settings.warnings.some((warning) => warning.includes("allowAgentModelOverrides")), false);
	});
});

test("allowAgentModelOverrides: profile value beats top level and absent profile value inherits", () => {
	withModelOverrideConfig(undefined, {
		allowAgentModelOverrides: true,
		profiles: {
			"project:inherits": { enabled: true },
			"project:off": { enabled: true, allowAgentModelOverrides: false },
		},
	}, true, (settings) => {
		assert.equal(resolveSubagentProfilePolicy(settings, "project:inherits").allowAgentModelOverrides, true);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:off").allowAgentModelOverrides, false);
		// Unconfigured profile ids still resolve the top-level value (enabled stays false).
		const other = resolveSubagentProfilePolicy(settings, "project:other");
		assert.equal(other.enabled, false);
		assert.equal(other.allowAgentModelOverrides, true);
	});
	withModelOverrideConfig(undefined, {
		allowAgentModelOverrides: false,
		profiles: { "project:on": { enabled: true, allowAgentModelOverrides: true } },
	}, true, (settings) => {
		assert.equal(resolveSubagentProfilePolicy(settings, "project:on").allowAgentModelOverrides, true);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:on", "explicit-backend").allowAgentModelOverrides, true);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:on", "explicit-backend").backend.source, "explicit");
	});
});

test("allowAgentModelOverrides: global/project layers merge per field and project can revoke", () => {
	withModelOverrideConfig(
		{ allowAgentModelOverrides: true, profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: true } } },
		{ profiles: { "project:worker": { timeoutMs: 30_000 } } },
		true,
		(settings) => {
			assert.equal(settings.allowAgentModelOverrides, true);
			const policy = resolveSubagentProfilePolicy(settings, "project:worker");
			assert.equal(policy.enabled, true);
			assert.equal(policy.timeout.milliseconds, 30_000);
			assert.equal(policy.allowAgentModelOverrides, true);
		},
	);
	withModelOverrideConfig(
		{ allowAgentModelOverrides: true, profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: true } } },
		{ allowAgentModelOverrides: false, profiles: { "project:worker": { allowAgentModelOverrides: false } } },
		true,
		(settings) => {
			assert.equal(settings.allowAgentModelOverrides, false);
			assert.equal(resolveSubagentProfilePolicy(settings, "project:worker").allowAgentModelOverrides, false);
		},
	);
});

test("allowAgentModelOverrides: explicit non-booleans including null fail closed with warnings", () => {
	const nonBooleans: unknown[] = [null, "true", "false", 0, 1, {}, [], ["true"]];
	for (const value of nonBooleans) {
		withModelOverrideConfig(
			{ allowAgentModelOverrides: true, profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: true } } },
			{ allowAgentModelOverrides: value, profiles: { "project:worker": { allowAgentModelOverrides: value } } },
			true,
			(settings) => {
				const label = JSON.stringify(value);
				assert.equal(settings.allowAgentModelOverrides, false, label);
				assert.equal(settings.profiles["project:worker"]?.allowAgentModelOverrides, false, label);
				assert.equal(resolveSubagentProfilePolicy(settings, "project:worker").allowAgentModelOverrides, false, label);
				assert.equal(settings.warnings.some((w) => w.includes("project allowAgentModelOverrides must be boolean; set to false")), true, label);
				assert.equal(settings.warnings.some((w) => w.includes("project profile project:worker allowAgentModelOverrides must be boolean; set to false")), true, label);
			},
		);
	}
	// A bad profile value fails closed even when the top level is enabled.
	withModelOverrideConfig(undefined, { allowAgentModelOverrides: true, profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: null } } }, true, (settings) => {
		assert.equal(resolveSubagentProfilePolicy(settings, "project:worker").allowAgentModelOverrides, false);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:other").allowAgentModelOverrides, true);
	});
});

test("allowAgentModelOverrides: invalid lower layer is overridden by a valid higher layer, legacy is fallback", () => {
	withModelOverrideConfig({ allowAgentModelOverrides: "bad" }, { allowAgentModelOverrides: true }, true, (settings) => {
		assert.equal(settings.allowAgentModelOverrides, true);
		assert.equal(settings.warnings.some((w) => w.includes("global allowAgentModelOverrides must be boolean; set to false")), true);
	});
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-model-override-legacy-"));
	const globalForgeDir = mkdtempSync(join(tmpdir(), "pi-forge-subagents-model-override-legacy-global-"));
	const previousGlobalDir = process.env.PI_FORGE_GLOBAL_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_DIR = globalForgeDir;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "config.json"), JSON.stringify({ subagents: { allowAgentModelOverrides: true } }), "utf8");
		assert.equal(loadForgeSubagentSettings(context(cwd)).allowAgentModelOverrides, true);
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({ allowAgentModelOverrides: false }), "utf8");
		assert.equal(loadForgeSubagentSettings(context(cwd)).allowAgentModelOverrides, false);
	} finally {
		if (previousGlobalDir === undefined) delete process.env.PI_FORGE_GLOBAL_DIR;
		else process.env.PI_FORGE_GLOBAL_DIR = previousGlobalDir;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalForgeDir, { recursive: true, force: true });
	}
});

test("allowAgentModelOverrides: untrusted project cannot grant, revoke, or warn about project values", () => {
	for (const value of [true, false, null, "x"]) {
		withModelOverrideConfig(
			{ allowAgentModelOverrides: true, profiles: { "global:reviewer": { enabled: true } } },
			{ allowAgentModelOverrides: value, profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: value } } },
			false,
			(settings) => {
				assert.equal(settings.allowAgentModelOverrides, true);
				assert.equal(settings.profiles["project:worker"], undefined);
				assert.equal(resolveSubagentProfilePolicy(settings, "project:worker").enabled, false);
				assert.equal(resolveSubagentProfilePolicy(settings, "global:reviewer").allowAgentModelOverrides, true);
				assert.equal(settings.warnings.some((w) => w.includes("allowAgentModelOverrides must be boolean")), false);
			},
		);
	}
	withModelOverrideConfig(undefined, { allowAgentModelOverrides: true, profiles: { "project:worker": { enabled: true, allowAgentModelOverrides: true } } }, false, (settings) => {
		assert.equal(settings.allowAgentModelOverrides, false);
		assert.equal(resolveSubagentProfilePolicy(settings, "project:worker").allowAgentModelOverrides, false);
	});
});
