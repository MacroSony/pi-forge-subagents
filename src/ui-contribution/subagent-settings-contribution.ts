import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	UiContributionProvider,
	type UiContributionPortResult,
	type UiContributionTabDescriptor,
	type UiContributionTransport,
	type UiWriteValuesResponse,
} from "@zihanw/pi-forge/ui-contribution";
import {
	MAX_SUBAGENT_TIMEOUT_MS,
	MIN_SUBAGENT_TIMEOUT_MS,
	globalSubagentsConfigPath,
	isValidSubagentTimeoutMs,
	loadForgeSubagentSettings,
	projectSubagentsConfigPath,
	type ForgeSubagentSettings,
} from "../config/subagents.ts";

export const SUBAGENT_SETTINGS_TAB_ID = "subagent-config";
const SUBAGENT_SETTINGS_TITLE = "Subagent Settings";
const SUBAGENT_SETTINGS_ICON = "⚙";
const PROFILE_FIELDS = ["enabled", "backend", "timeoutMs"] as const;
const TOP_LEVEL_FIELDS = ["backend", "timeoutMs", "allowAgentInvocationWithoutApproval", "summaryInToolDescription", "profiles"] as const;

export function buildSubagentSettingsSchema(): UiContributionTabDescriptor["schema"] {
	return {
		title: SUBAGENT_SETTINGS_TITLE,
		description: "Configure the optional Pi Forge subagent integration.",
		fields: [
			{
				key: "backend",
				label: "Default backend",
				type: "string",
				description: "Default subagent execution backend. Leave empty to use the built-in backend.",
				placeholder: "pi-subprocess-readonly",
				maxLength: 128,
			},
			{
				key: "timeoutMs",
				label: "Default timeout (ms)",
				type: "number",
				required: true,
				description: `Default subagent timeout in milliseconds (${MIN_SUBAGENT_TIMEOUT_MS}-${MAX_SUBAGENT_TIMEOUT_MS}).`,
				min: MIN_SUBAGENT_TIMEOUT_MS,
				max: MAX_SUBAGENT_TIMEOUT_MS,
			},
			{
				key: "allowAgentInvocationWithoutApproval",
				label: "Allow unattended invocation",
				type: "boolean",
				description: "When enabled, trusted projects may run subagents without per-run human approval.",
			},
			{
				key: "summaryInToolDescription",
				label: "Summarize profiles in tool description",
				type: "boolean",
				description: "When enabled, forge_subagent's tool description includes enabled profile summaries.",
			},
			{
				key: "profiles",
				label: "Per-profile overrides",
				type: "record",
				keyLabel: "Profile ID",
				keyPlaceholder: "project:worker",
				description: "Per-profile enabled/backend/timeout overrides. Empty backend or timeout inherits the top-level value.",
				recordFields: [
					{ key: "enabled", label: "Enabled", type: "boolean" },
					{ key: "backend", label: "Backend", type: "string", placeholder: "pi-subprocess-readonly", maxLength: 128 },
					{ key: "timeoutMs", label: "Timeout (ms)", type: "string", placeholder: "60000", maxLength: 16 },
				],
			},
		],
	};
}

export function settingsToContributionValues(settings: ForgeSubagentSettings): UiContributionTabDescriptor["values"] {
	const profiles: Record<string, unknown> = {};
	for (const [profileId, profile] of Object.entries(settings.profiles)) {
		profiles[profileId] = {
			enabled: profile.enabled ?? false,
			backend: profile.backend ?? "",
			timeoutMs: profile.timeoutMs === undefined || profile.timeoutMs === null ? "" : String(profile.timeoutMs),
		};
	}
	return {
		backend: settings.backend ?? "",
		timeoutMs: settings.timeoutMs,
		allowAgentInvocationWithoutApproval: settings.allowAgentInvocationWithoutApproval ?? false,
		summaryInToolDescription: settings.summaryInToolDescription ?? false,
		profiles,
	};
}

export function buildSubagentSettingsTab(ctx: ExtensionContext): UiContributionTabDescriptor {
	const settings = loadForgeSubagentSettings(ctx);
	return {
		tabId: SUBAGENT_SETTINGS_TAB_ID,
		title: SUBAGENT_SETTINGS_TITLE,
		icon: SUBAGENT_SETTINGS_ICON,
		schema: buildSubagentSettingsSchema(),
		values: settingsToContributionValues(settings),
	};
}

export function createForgeSubagentSettingsContribution(
	transport: UiContributionTransport,
	contextProvider: () => ExtensionContext | undefined,
): UiContributionProvider {
	return new UiContributionProvider(transport, {
		providerId: "pi-forge-subagents-settings",
		handle(operation, payload): UiContributionPortResult {
			if (operation === "listContributions") {
				const ctx = contextProvider();
				if (!ctx) return { ok: false, error: "No active subagent session context." };
				return { ok: true, data: { tabs: [buildSubagentSettingsTab(ctx)] } };
			}
			if (operation === "writeValues") {
				const ctx = contextProvider();
				if (!ctx) return { ok: false, error: "No active subagent session context." };
				const request = payload as { tabId?: unknown; patch?: unknown };
				if (request.tabId !== SUBAGENT_SETTINGS_TAB_ID) {
					return { ok: true, data: { ok: false, errors: { tabId: "Unknown contribution tab." } } };
				}
				if (!request.patch || typeof request.patch !== "object" || Array.isArray(request.patch)) {
					return { ok: true, data: { ok: false, errors: { patch: "Patch must be an object." } } };
				}
				const writeResult = writeSubagentSettingsValues(ctx, request.patch as Record<string, unknown>);
				return { ok: true, data: writeResult };
			}
			return { ok: false, error: `Unknown UI contribution operation: ${operation}` };
		},
	});
}

export function writeSubagentSettingsValues(
	ctx: ExtensionContext,
	patch: Record<string, unknown>,
): UiWriteValuesResponse {
	const errors = validateSettingsPatch(patch);
	if (Object.keys(errors).length > 0) return { ok: false, errors };

	const settings = loadForgeSubagentSettings(ctx);
	const projectTrusted = ctx.isProjectTrusted();
	const projectPath = projectSubagentsConfigPath(ctx.cwd);
	const globalPath = globalSubagentsConfigPath();
	const projectFile = readConfigFile(projectPath);
	const globalFile = readConfigFile(globalPath);

	for (const key of TOP_LEVEL_FIELDS) {
		if (key === "profiles" || !(key in patch)) continue;
		const target = targetFileForTopLevel(key, settings, projectFile, globalFile, projectTrusted);
		const file = target === "project" ? projectFile : globalFile;
		const value = patch[key];
		if (value === "" && key === "backend") {
			delete file.backend;
		} else {
			file[key] = value;
		}
	}

	if ("profiles" in patch && patch.profiles !== undefined) {
		const profilesPatch = patch.profiles as Record<string, Record<string, unknown>>;
		for (const [profileId, row] of Object.entries(profilesPatch)) {
			const target = targetFileForProfile(profileId, settings, projectFile, globalFile, projectTrusted);
			const file = target === "project" ? projectFile : globalFile;
			applyProfilePatch(file, profileId, row);
		}
	}

	writeConfigFile(projectPath, projectFile);
	writeConfigFile(globalPath, globalFile);

	const updated = loadForgeSubagentSettings(ctx);
	return { ok: true, values: settingsToContributionValues(updated) };
}

function validateSettingsPatch(patch: Record<string, unknown>): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const key of Object.keys(patch)) {
		if (!(TOP_LEVEL_FIELDS as readonly string[]).includes(key)) errors[key] = "Unknown setting.";
	}
	if ("backend" in patch && patch.backend !== undefined && patch.backend !== "") {
		if (typeof patch.backend !== "string") errors.backend = "Backend must be a string.";
		else if (patch.backend.length > 128) errors.backend = "Backend must be at most 128 characters.";
	}
	if ("timeoutMs" in patch && patch.timeoutMs !== undefined && !isValidSubagentTimeoutMs(patch.timeoutMs)) {
		errors.timeoutMs = `Timeout must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`;
	}
	if ("allowAgentInvocationWithoutApproval" in patch && patch.allowAgentInvocationWithoutApproval !== undefined && typeof patch.allowAgentInvocationWithoutApproval !== "boolean") {
		errors.allowAgentInvocationWithoutApproval = "Allow unattended invocation must be a boolean.";
	}
	if ("summaryInToolDescription" in patch && patch.summaryInToolDescription !== undefined && typeof patch.summaryInToolDescription !== "boolean") {
		errors.summaryInToolDescription = "Summary in tool description must be a boolean.";
	}
	if ("profiles" in patch && patch.profiles !== undefined) {
		if (!isPlainRecord(patch.profiles)) {
			errors.profiles = "Profiles must be a table of entries.";
		} else {
			for (const [profileId, row] of Object.entries(patch.profiles)) {
				if (!profileId.trim()) {
					errors.profiles = errors.profiles ?? "Every profile needs a key.";
					continue;
				}
				if (!isPlainRecord(row)) {
					errors[`profiles.${profileId}`] = "Profile settings must be an object.";
					continue;
				}
				for (const key of Object.keys(row)) {
					if (!(PROFILE_FIELDS as readonly string[]).includes(key)) {
						errors[`profiles.${profileId}.${key}`] = "Unknown profile setting.";
					}
				}
				if ("enabled" in row && row.enabled !== undefined && typeof row.enabled !== "boolean") {
					errors[`profiles.${profileId}.enabled`] = "Enabled must be a boolean.";
				}
				if ("backend" in row && row.backend !== undefined && row.backend !== null) {
					if (typeof row.backend !== "string") {
						errors[`profiles.${profileId}.backend`] = "Backend must be a string.";
					} else if (row.backend.length > 128) {
						errors[`profiles.${profileId}.backend`] = "Backend must be at most 128 characters.";
					}
				}
				if ("timeoutMs" in row && row.timeoutMs !== undefined && row.timeoutMs !== null && row.timeoutMs !== "") {
					const timeout = typeof row.timeoutMs === "number" ? row.timeoutMs : Number(row.timeoutMs);
					if (!isValidSubagentTimeoutMs(timeout)) {
						errors[`profiles.${profileId}.timeoutMs`] = `Timeout must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`;
					}
				}
			}
		}
	}
	return errors;
}

function targetFileForTopLevel(
	key: string,
	settings: ForgeSubagentSettings,
	projectFile: Record<string, unknown>,
	globalFile: Record<string, unknown>,
	projectTrusted: boolean,
): "project" | "global" {
	const source = key === "backend"
		? settings.backendSource
		: key === "timeoutMs"
			? settings.timeoutSource
			: key === "summaryInToolDescription"
				? settings.summaryInToolDescriptionSource
				: undefined;
	if (source === "project") return "project";
	if (source === "global") return "global";
	if (projectFile[key] !== undefined) return "project";
	if (globalFile[key] !== undefined) return "global";
	return projectTrusted ? "project" : "global";
}

function targetFileForProfile(
	profileId: string,
	settings: ForgeSubagentSettings,
	projectFile: Record<string, unknown>,
	globalFile: Record<string, unknown>,
	projectTrusted: boolean,
): "project" | "global" {
	const source = settings.profilesSource[profileId];
	if (source === "project") return "project";
	if (source === "global") return "global";
	if (isPlainRecord(projectFile.profiles) && projectFile.profiles[profileId] !== undefined) return "project";
	if (isPlainRecord(globalFile.profiles) && globalFile.profiles[profileId] !== undefined) return "global";
	return projectTrusted ? "project" : "global";
}

function applyProfilePatch(
	file: Record<string, unknown>,
	profileId: string,
	row: Record<string, unknown>,
): void {
	const profiles = isPlainRecord(file.profiles) ? file.profiles : {};
	const current = isPlainRecord(profiles[profileId]) ? profiles[profileId] : {} as Record<string, unknown>;
	if ("enabled" in row) current.enabled = row.enabled;
	if ("backend" in row) {
		current.backend = row.backend === "" || row.backend === null ? null : row.backend;
	}
	if ("timeoutMs" in row) {
		current.timeoutMs = row.timeoutMs === "" || row.timeoutMs === null
			? null
			: typeof row.timeoutMs === "number" ? row.timeoutMs : Number(row.timeoutMs);
	}
	profiles[profileId] = current;
	file.profiles = profiles;
}

function readConfigFile(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isPlainRecord(parsed)) return parsed;
		return {};
	} catch {
		return {};
	}
}

function writeConfigFile(path: string, file: Record<string, unknown>): void {
	if (Object.keys(file).length === 0) {
		if (existsSync(path)) {
			writeFileSync(path, "{}", "utf8");
		}
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
