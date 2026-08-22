import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeProfileSummary } from "@zihanw/pi-forge/subagent";
import { UiContributionClient } from "@zihanw/pi-forge/ui-contribution";
import {
	GLOBAL_SUBAGENT_SETTINGS_TAB_ID,
	PROJECT_SUBAGENT_SETTINGS_TAB_ID,
	buildSubagentSettingsSchema,
	buildSubagentSettingsTabs,
	createForgeSubagentSettingsContribution,
	scopedConfigToContributionValues,
	writeScopedSubagentSettings,
} from "../src/ui-contribution/subagent-settings-contribution.ts";
import { globalSubagentsConfigPath, projectSubagentsConfigPath } from "../src/config/subagents.ts";

class MemoryTransport {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
		set.add(handler);
		this.handlers.set(channel, set);
		return () => set.delete(handler);
	}
}

const GLOBAL_ROOT = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-global-"));
process.env.PI_FORGE_GLOBAL_FORGE_DIR = GLOBAL_ROOT;
test.after(() => rmSync(GLOBAL_ROOT, { recursive: true, force: true }));

function context(cwd: string, trusted = true) {
	return { cwd, isProjectTrusted: () => trusted } as any;
}

function profile(profileId: string, scope: "project" | "global", overrides: Partial<ForgeProfileSummary> = {}): ForgeProfileSummary {
	return {
		profileId,
		scope,
		name: profileId === "worker" ? "Worker" : profileId,
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		promptStack: null,
		usable: true,
		diagnostics: [],
		...overrides,
	};
}

const catalog = [profile("worker", "project"), profile("reviewer", "global")];

test("package requires the first pi-forge release that exposes ui-contribution", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(manifest.dependencies["@zihanw/pi-forge"], "^0.5.1");
});

function completeValues(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		backend: "",
		timeoutMs: "",
		allowAgentInvocationWithoutApproval: "inherit",
		summaryInToolDescription: "inherit",
		profiles: {},
		...overrides,
	};
}

test("settings tabs separate project and global raw configuration with catalog-backed profile keys", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-tabs-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({ profiles: { "project:missing": { enabled: true } } }), "utf8");
		const tabs = buildSubagentSettingsTabs(context(cwd), catalog);
		assert.deepEqual(tabs.map((tab) => tab.tabId), [PROJECT_SUBAGENT_SETTINGS_TAB_ID, GLOBAL_SUBAGENT_SETTINGS_TAB_ID]);
		assert.match(tabs[0]!.schema.description ?? "", new RegExp(projectSubagentsConfigPath(cwd).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.match(tabs[1]!.schema.description ?? "", /global configuration only/);

		const projectProfiles = tabs[0]!.schema.fields.find((field) => field.key === "profiles")!;
		assert.equal(projectProfiles.type, "record");
		assert.deepEqual(projectProfiles.keyOptions, [
			{ value: "project:worker", label: "Project · worker — Worker" },
			{ value: "project:missing", label: "project:missing · configured profile not found" },
		]);
		const globalProfiles = tabs[1]!.schema.fields.find((field) => field.key === "profiles")!;
		assert.deepEqual(globalProfiles.keyOptions, [{ value: "global:reviewer", label: "Global · reviewer" }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("duplicate catalog selectors are excluded without invalidating the settings contribution", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-duplicate-catalog-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");
		const duplicateCatalog = [
			profile("worker", "project", { usable: false }),
			profile("worker", "project", { usable: false, name: "Duplicate Worker" }),
			profile("reviewer", "global"),
		];
		const tabs = buildSubagentSettingsTabs(context(cwd), duplicateCatalog);
		assert.equal(tabs.length, 2);
		const profileField = tabs[0]!.schema.fields.find((field) => field.key === "profiles")!;
		assert.deepEqual(profileField.keyOptions, [{
			value: "project:worker",
			label: "project:worker · configured profile is ambiguous",
		}]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("untrusted projects expose only the global settings page", () => {
	const tabs = buildSubagentSettingsTabs(context("/untrusted", false), catalog);
	assert.deepEqual(tabs.map((tab) => tab.tabId), [GLOBAL_SUBAGENT_SETTINGS_TAB_ID]);
});

test("scoped values retain absence as inherit instead of materializing effective defaults", () => {
	assert.deepEqual(scopedConfigToContributionValues({
		backend: "pi-rpc-readonly",
		allowAgentInvocationWithoutApproval: false,
		profiles: { "global:reviewer": { enabled: true, timeoutMs: 30_000 } },
	}), {
		backend: "pi-rpc-readonly",
		timeoutMs: "",
		allowAgentInvocationWithoutApproval: "disabled",
		summaryInToolDescription: "inherit",
		profiles: {
			"global:reviewer": { enabled: true, backend: "", timeoutMs: "30000" },
		},
	});
});

test("scope schema uses tri-state overrides and no free-text profile id", () => {
	const schema = buildSubagentSettingsSchema("project", "/project/.pi/forge/subagents.json", catalog, {});
	assert.equal(schema.fields.find((field) => field.key === "timeoutMs")?.required, undefined);
	assert.deepEqual(schema.fields.find((field) => field.key === "allowAgentInvocationWithoutApproval")?.options, [
		{ value: "inherit", label: "Inherit" },
		{ value: "enabled", label: "Enabled" },
		{ value: "disabled", label: "Disabled" },
	]);
	assert.deepEqual(schema.fields.find((field) => field.key === "profiles")?.keyOptions?.map((option: any) => option.value), ["project:worker"]);
});

test("project writes replace the project profile table, delete omitted entries, and preserve unrelated keys", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-project-write-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({
			futureSetting: { keep: true },
			profiles: {
				"project:old": { enabled: true },
				"project:worker": { enabled: false, futureProfileSetting: { keep: true } },
			},
		}), "utf8");
		const result = writeScopedSubagentSettings(context(cwd), "project", completeValues({
			backend: "pi-rpc-readonly",
			timeoutMs: 120_000,
			allowAgentInvocationWithoutApproval: "enabled",
			profiles: { "project:worker": { enabled: true, backend: "", timeoutMs: "30000" } },
		}), catalog);
		assert.equal(result.ok, true);
		const projectFile = JSON.parse(readFileSync(projectSubagentsConfigPath(cwd), "utf8"));
		assert.deepEqual(projectFile.futureSetting, { keep: true });
		assert.equal(projectFile.profiles["project:old"], undefined);
		assert.deepEqual(projectFile.profiles["project:worker"], {
			enabled: true,
			futureProfileSetting: { keep: true },
			timeoutMs: 30_000,
		});
		assert.equal(projectFile.backend, "pi-rpc-readonly");
		assert.equal(projectFile.allowAgentInvocationWithoutApproval, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("empty and inherit values delete only the selected scope overrides", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-inherit-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({
			backend: "old",
			timeoutMs: 20_000,
			allowAgentInvocationWithoutApproval: true,
			summaryInToolDescription: false,
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");
		const result = writeScopedSubagentSettings(context(cwd), "project", completeValues(), catalog);
		assert.equal(result.ok, true);
		assert.deepEqual(JSON.parse(readFileSync(projectSubagentsConfigPath(cwd), "utf8")), {});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("partial patches preserve omitted scalar fields while an explicit profiles table replaces entries", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-partial-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({
			backend: "pi-rpc-readonly",
			timeoutMs: 90_000,
			allowAgentInvocationWithoutApproval: true,
			profiles: { "project:old": { enabled: true } },
		}), "utf8");
		const result = writeScopedSubagentSettings(context(cwd), "project", {
			profiles: { "project:worker": { enabled: true, backend: "", timeoutMs: "" } },
		}, catalog);
		assert.equal(result.ok, true);
		const saved = JSON.parse(readFileSync(projectSubagentsConfigPath(cwd), "utf8"));
		assert.equal(saved.backend, "pi-rpc-readonly");
		assert.equal(saved.timeoutMs, 90_000);
		assert.equal(saved.allowAgentInvocationWithoutApproval, true);
		assert.deepEqual(saved.profiles, { "project:worker": { enabled: true } });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("new nonexistent and cross-scope profile entries are rejected without writing", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-invalid-profile-"));
	try {
		const missing = writeScopedSubagentSettings(context(cwd), "project", completeValues({
			profiles: { "project:ghost": { enabled: true, backend: "", timeoutMs: "" } },
		}), catalog);
		assert.equal(missing.ok, false);
		if (!missing.ok) assert.match(missing.errors["profiles.project:ghost"] ?? "", /does not exist/);

		const wrongScope = writeScopedSubagentSettings(context(cwd), "project", completeValues({
			profiles: { "global:reviewer": { enabled: true, backend: "", timeoutMs: "" } },
		}), catalog);
		assert.equal(wrongScope.ok, false);
		assert.equal(existsSync(projectSubagentsConfigPath(cwd)), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("new entries cannot target an ambiguous duplicate profile selector", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-ambiguous-profile-"));
	try {
		const duplicateCatalog = [profile("worker", "project"), profile("worker", "project")];
		const result = writeScopedSubagentSettings(context(cwd), "project", completeValues({
			profiles: { "project:worker": { enabled: true, backend: "", timeoutMs: "" } },
		}), duplicateCatalog);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors["profiles.project:worker"] ?? "", /ambiguous|duplicate/i);
		assert.equal(existsSync(projectSubagentsConfigPath(cwd)), false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("configured missing profiles may be retained or deleted but not newly recreated", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-orphan-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({ profiles: { "project:gone": { enabled: true } } }), "utf8");
		const retained = writeScopedSubagentSettings(context(cwd), "project", completeValues({
			profiles: { "project:gone": { enabled: false, backend: "", timeoutMs: "" } },
		}), catalog);
		assert.equal(retained.ok, true);
		const removed = writeScopedSubagentSettings(context(cwd), "project", completeValues(), catalog);
		assert.equal(removed.ok, true);
		assert.equal(JSON.parse(readFileSync(projectSubagentsConfigPath(cwd), "utf8")).profiles, undefined);
		const recreated = writeScopedSubagentSettings(context(cwd), "project", completeValues({
			profiles: { "project:gone": { enabled: true, backend: "", timeoutMs: "" } },
		}), catalog);
		assert.equal(recreated.ok, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("malformed scoped config is reported and never overwritten by autosave", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-malformed-"));
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		const path = projectSubagentsConfigPath(cwd);
		writeFileSync(path, "{ not valid JSON", "utf8");
		const tabs = buildSubagentSettingsTabs(context(cwd), catalog);
		assert.match(tabs[0]!.schema.description ?? "", /Cannot edit .*Failed to parse/);
		const result = writeScopedSubagentSettings(context(cwd), "project", { backend: "new" }, catalog);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.errors.config ?? "", /Fix the JSON file/);
		assert.equal(readFileSync(path, "utf8"), "{ not valid JSON");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("global writes never mutate project configuration and project writes require trust", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-global-write-"));
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-global-root-"));
	const previous = process.env.PI_FORGE_GLOBAL_FORGE_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_FORGE_DIR = globalRoot;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(projectSubagentsConfigPath(cwd), JSON.stringify({ projectOnly: true }), "utf8");
		const globalResult = writeScopedSubagentSettings(context(cwd), "global", completeValues({
			profiles: { "global:reviewer": { enabled: true, backend: "", timeoutMs: "" } },
		}), catalog);
		assert.equal(globalResult.ok, true);
		assert.equal(JSON.parse(readFileSync(projectSubagentsConfigPath(cwd), "utf8")).projectOnly, true);
		assert.equal(JSON.parse(readFileSync(globalSubagentsConfigPath(), "utf8")).profiles["global:reviewer"].enabled, true);

		const untrusted = writeScopedSubagentSettings(context(cwd, false), "project", completeValues(), catalog);
		assert.equal(untrusted.ok, false);
	} finally {
		if (previous === undefined) delete process.env.PI_FORGE_GLOBAL_FORGE_DIR;
		else process.env.PI_FORGE_GLOBAL_FORGE_DIR = previous;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalRoot, { recursive: true, force: true });
	}
});

test("UI contribution provider refreshes the host profile catalog for list and write", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-port-"));
	try {
		const bus = new MemoryTransport();
		let catalogReads = 0;
		const provider = createForgeSubagentSettingsContribution(bus, () => context(cwd), async () => {
			catalogReads += 1;
			return catalog;
		});
		provider.start();
		const client = new UiContributionClient(bus, { defaultTimeoutMs: 200 });
		const connection = await client.discover();
		client.connect(connection);
		const listed = await client.listContributions(connection);
		assert.equal(listed.ok, true, JSON.stringify(listed));
		const tabs = (listed.data as { tabs: Array<{ tabId: string }> }).tabs;
		assert.deepEqual(tabs.map((tab) => tab.tabId), [PROJECT_SUBAGENT_SETTINGS_TAB_ID, GLOBAL_SUBAGENT_SETTINGS_TAB_ID]);

		const written = await client.writeValues(connection, PROJECT_SUBAGENT_SETTINGS_TAB_ID, completeValues({
			profiles: { "project:worker": { enabled: true, backend: "", timeoutMs: "" } },
		}));
		assert.equal(written.ok, true);
		assert.equal((written.data as { ok: boolean }).ok, true);
		assert.equal(catalogReads, 2);
		provider.stop();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("stopped async provider generations cannot write after a replacement provider saves", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-ui-stale-provider-"));
	try {
		const bus = new MemoryTransport();
		let releaseCatalog!: () => void;
		let catalogStarted!: () => void;
		const started = new Promise<void>((resolve) => { catalogStarted = resolve; });
		const blockedCatalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
		const oldProvider = createForgeSubagentSettingsContribution(bus, () => context(cwd), async () => {
			catalogStarted();
			await blockedCatalog;
			return catalog;
		});
		oldProvider.start();
		const oldClient = new UiContributionClient(bus, { defaultTimeoutMs: 500 });
		const oldConnection = await oldClient.discover();
		oldClient.connect(oldConnection);
		const oldWrite = oldClient.writeValues(oldConnection, PROJECT_SUBAGENT_SETTINGS_TAB_ID, completeValues({ backend: "stale" }));
		await started;
		oldProvider.stop();

		const newProvider = createForgeSubagentSettingsContribution(bus, () => context(cwd), async () => catalog);
		newProvider.start();
		const newClient = new UiContributionClient(bus, { defaultTimeoutMs: 500 });
		const newConnection = await newClient.discover();
		newClient.connect(newConnection);
		const newWrite = await newClient.writeValues(newConnection, PROJECT_SUBAGENT_SETTINGS_TAB_ID, completeValues({ backend: "fresh" }));
		assert.equal(newWrite.ok, true);
		releaseCatalog();
		await oldWrite;
		assert.equal(JSON.parse(readFileSync(projectSubagentsConfigPath(cwd), "utf8")).backend, "fresh");
		newProvider.stop();
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
