import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UiContributionClient } from "@zihanw/pi-forge/ui-contribution";
import {
	SUBAGENT_SETTINGS_TAB_ID,
	buildSubagentSettingsSchema,
	createForgeSubagentSettingsContribution,
	settingsToContributionValues,
	writeSubagentSettingsValues,
} from "../src/ui-contribution/subagent-settings-contribution.ts";
import {
	globalSubagentsConfigPath,
	loadForgeSubagentSettings,
	projectSubagentsConfigPath,
} from "../src/config/subagents.ts";

class MemoryTransport {
	private handlers = new Map<string, Set<(data: unknown) => void>>();

	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
		set.add(handler);
		this.handlers.set(channel, set);
		let off = false;
		return () => {
			if (!off) {
				off = true;
				set.delete(handler);
			}
		};
	}
}

const GLOBAL_ROOT = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-global-"));
process.env.PI_FORGE_GLOBAL_FORGE_DIR = GLOBAL_ROOT;
test.after(() => {
	rmSync(GLOBAL_ROOT, { recursive: true, force: true });
});

function context(cwd: string, trusted = true) {
	return { cwd, isProjectTrusted: () => trusted } as any;
}

test("subagent settings schema maps the expected fields and record columns", () => {
	const schema = buildSubagentSettingsSchema();
	assert.deepEqual(schema.fields.map((field) => field.key), [
		"backend",
		"timeoutMs",
		"allowAgentInvocationWithoutApproval",
		"summaryInToolDescription",
		"profiles",
	]);

	const backend = schema.fields.find((field) => field.key === "backend")!;
	assert.equal(backend.type, "string");

	const timeout = schema.fields.find((field) => field.key === "timeoutMs")!;
	assert.equal(timeout.type, "number");
	assert.equal(timeout.required, true);

	const profiles = schema.fields.find((field) => field.key === "profiles")!;
	assert.equal(profiles.type, "record");
	assert.deepEqual(profiles.recordFields?.map((field) => field.key), ["enabled", "backend", "timeoutMs"]);
});

test("settingsToContributionValues renders empty strings for unset profile overrides", () => {
	const settings = {
		backend: "pi-rpc-readonly",
		backendSource: "project",
		timeoutMs: 90_000,
		timeoutSource: "global",
		allowAgentInvocationWithoutApproval: true,
		summaryInToolDescription: true,
		summaryInToolDescriptionSource: "project",
		profiles: {
			"project:worker": { enabled: true, backend: "pi-subprocess-readonly", timeoutMs: 30_000 },
			"global:reviewer": { enabled: false },
		},
		profilesSource: {
			"project:worker": "project",
			"global:reviewer": "global",
		},
		warnings: [],
	} as any;

	const values = settingsToContributionValues(settings);
	assert.equal(values.backend, "pi-rpc-readonly");
	assert.equal(values.timeoutMs, 90_000);
	assert.equal(values.allowAgentInvocationWithoutApproval, true);
	assert.equal(values.summaryInToolDescription, true);
	const profiles = values.profiles as Record<string, Record<string, unknown>>;
	assert.deepEqual(profiles["project:worker"], {
		enabled: true,
		backend: "pi-subprocess-readonly",
		timeoutMs: "30000",
	});
	assert.deepEqual(profiles["global:reviewer"], {
		enabled: false,
		backend: "",
		timeoutMs: "",
	});
});

test("writeSubagentSettingsValues rejects invalid values without writing", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-invalid-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		const ctx = context(cwd);

		const invalidTimeout = writeSubagentSettingsValues(ctx, { timeoutMs: 0 });
		assert.equal(invalidTimeout.ok, false);
		if (!invalidTimeout.ok) assert.match(invalidTimeout.errors.timeoutMs ?? "", /integer from 1000 to 3600000/);

		const invalidProfileTimeout = writeSubagentSettingsValues(ctx, {
			profiles: { "project:worker": { enabled: true, timeoutMs: "later" } },
		});
		assert.equal(invalidProfileTimeout.ok, false);
		if (!invalidProfileTimeout.ok) assert.match(invalidProfileTimeout.errors["profiles.project:worker.timeoutMs"] ?? "", /integer from 1000 to 3600000/);

		const unknownField = writeSubagentSettingsValues(ctx, { nope: true });
		assert.equal(unknownField.ok, false);
		if (!unknownField.ok) assert.equal(unknownField.errors.nope, "Unknown setting.");

		const wrongType = writeSubagentSettingsValues(ctx, { allowAgentInvocationWithoutApproval: "yes" });
		assert.equal(wrongType.ok, false);
		if (!wrongType.ok) assert.match(wrongType.errors.allowAgentInvocationWithoutApproval ?? "", /boolean/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("writeSubagentSettingsValues persists project settings to the project subagents.json", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-project-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		const ctx = context(cwd);
		const result = writeSubagentSettingsValues(ctx, {
			backend: "pi-rpc-readonly",
			timeoutMs: 120_000,
			allowAgentInvocationWithoutApproval: true,
			summaryInToolDescription: true,
			profiles: {
				"project:worker": { enabled: true, backend: "pi-subprocess-readonly", timeoutMs: "30000" },
			},
		});
		assert.equal(result.ok, true);

		const projectPath = projectSubagentsConfigPath(cwd);
		assert.equal(existsSync(projectPath), true);
		const project = JSON.parse(readFileSync(projectPath, "utf8"));
		assert.equal(project.backend, "pi-rpc-readonly");
		assert.equal(project.timeoutMs, 120_000);
		assert.equal(project.allowAgentInvocationWithoutApproval, true);
		assert.equal(project.summaryInToolDescription, true);
		assert.deepEqual(project.profiles["project:worker"], {
			enabled: true,
			backend: "pi-subprocess-readonly",
			timeoutMs: 30_000,
		});

		const reloaded = loadForgeSubagentSettings(ctx);
		assert.equal(reloaded.backend, "pi-rpc-readonly");
		assert.equal(reloaded.timeoutMs, 120_000);
		assert.equal(reloaded.profiles["project:worker"]?.enabled, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("writeSubagentSettingsValues preserves global provenance for existing global values", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-global-cwd-"));
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-global-root-"));
	const previousForge = process.env.PI_FORGE_GLOBAL_FORGE_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_FORGE_DIR = globalRoot;
		mkdirSync(join(globalRoot, ".pi", "forge"), { recursive: true });
		writeFileSync(join(globalRoot, ".pi", "forge", "subagents.json"), JSON.stringify({
			backend: "pi-rpc-readonly",
			timeoutMs: 90_000,
			profiles: {
				"global:worker": { enabled: true, backend: "pi-rpc-readonly", timeoutMs: 20_000 },
			},
		}), "utf8");
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		const ctx = context(cwd);
		const result = writeSubagentSettingsValues(ctx, {
			backend: "pi-subprocess-readonly",
			profiles: {
				"global:worker": { enabled: true, backend: "pi-subprocess-readonly", timeoutMs: "30000" },
			},
		});
		assert.equal(result.ok, true);

		const global = JSON.parse(readFileSync(globalSubagentsConfigPath(), "utf8"));
		assert.equal(global.backend, "pi-subprocess-readonly");
		assert.deepEqual(global.profiles["global:worker"], {
			enabled: true,
			backend: "pi-subprocess-readonly",
			timeoutMs: 30_000,
		});

		const project = JSON.parse(readFileSync(projectSubagentsConfigPath(cwd), "utf8"));
		assert.equal(project.backend, undefined);
		assert.equal(project.profiles["project:worker"]?.enabled, true);
		assert.equal(project.profiles["global:worker"], undefined);
	} finally {
		if (previousForge === undefined) delete process.env.PI_FORGE_GLOBAL_FORGE_DIR;
		else process.env.PI_FORGE_GLOBAL_FORGE_DIR = previousForge;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalRoot, { recursive: true, force: true });
	}
});

test("subagent settings tab id is exported for the provider descriptor", () => {
	assert.equal(SUBAGENT_SETTINGS_TAB_ID, "subagent-config");
});

test("ui contribution provider lists the settings tab and routes writeValues", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-port-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		const bus = new MemoryTransport();
		const provider = createForgeSubagentSettingsContribution(bus, () => context(cwd));
		provider.start();
		const client = new UiContributionClient(bus, { defaultTimeoutMs: 200 });
		const connection = await client.discover();
		client.connect(connection);

		const listed = await client.listContributions(connection);
		assert.equal(listed.ok, true);
		const tabs = (listed.data as { tabs: Array<{ tabId: string; schema: { fields: unknown[] } }> }).tabs;
		assert.equal(tabs.length, 1);
		assert.equal(tabs[0]!.tabId, "subagent-config");
		assert.equal(tabs[0]!.schema.fields.length, 5);

		const written = await client.writeValues(connection, "subagent-config", { timeoutMs: 90_000 });
		assert.equal(written.ok, true);
		const writeData = written.data as { ok: boolean; values?: Record<string, unknown> };
		assert.equal(writeData.ok, true);
		assert.equal(writeData.values?.timeoutMs, 90_000);

		provider.stop();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
