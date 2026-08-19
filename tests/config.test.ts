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
