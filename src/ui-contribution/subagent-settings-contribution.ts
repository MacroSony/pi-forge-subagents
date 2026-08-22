import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForgeProfileSummary } from "@zihanw/pi-forge/subagent";
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
	projectSubagentsConfigPath,
} from "../config/subagents.ts";

export const PROJECT_SUBAGENT_SETTINGS_TAB_ID = "subagent-config-project";
export const GLOBAL_SUBAGENT_SETTINGS_TAB_ID = "subagent-config-global";
const SUBAGENT_SETTINGS_ICON = "⚙";
const FORM_FIELDS = ["backend", "timeoutMs", "allowAgentInvocationWithoutApproval", "summaryInToolDescription", "profiles"] as const;
const PROFILE_FIELDS = ["enabled", "backend", "timeoutMs"] as const;
const BOOLEAN_CHOICES = [
	{ value: "inherit", label: "Inherit" },
	{ value: "enabled", label: "Enabled" },
	{ value: "disabled", label: "Disabled" },
] as const;

type SettingsScope = "project" | "global";
type ProfileCatalogProvider = () => Promise<readonly ForgeProfileSummary[]>;
interface ConfigReadResult {
	value: Record<string, unknown>;
	error?: string;
}

export function buildSubagentSettingsSchema(
	scope: SettingsScope,
	configPath: string,
	profiles: readonly ForgeProfileSummary[],
	rawConfig: Record<string, unknown>,
	configError?: string,
): UiContributionTabDescriptor["schema"] {
	const scopeName = scope === "project" ? "Project" : "Global";
	const inheritedFrom = scope === "project" ? "global settings, then built-in defaults" : "built-in defaults";
	return {
		title: `${scopeName} Subagent Settings`,
		description: configError
			? `Cannot edit ${configPath}: ${configError} Fix the JSON file on disk before saving.`
			: `Editing ${scopeName.toLowerCase()} configuration only: ${configPath}. Empty or Inherit removes this scope's override and falls back to ${inheritedFrom}.`,
		fields: [
			{
				key: "backend",
				label: "Default backend override",
				type: "string",
				description: "Leave empty to inherit instead of writing an empty backend.",
				placeholder: "Inherit",
				maxLength: 128,
			},
			{
				key: "timeoutMs",
				label: "Default timeout override (ms)",
				type: "number",
				default: "",
				description: `Leave empty to inherit. Overrides must be ${MIN_SUBAGENT_TIMEOUT_MS}-${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`,
				min: MIN_SUBAGENT_TIMEOUT_MS,
				max: MAX_SUBAGENT_TIMEOUT_MS,
			},
			{
				key: "allowAgentInvocationWithoutApproval",
				label: "Allow unattended invocation",
				type: "enum",
				options: booleanOptions(),
				description: "Inherit removes this scope's override.",
			},
			{
				key: "summaryInToolDescription",
				label: "Summarize profiles in tool description",
				type: "enum",
				options: booleanOptions(),
				description: "Inherit removes this scope's override.",
			},
			{
				key: "profiles",
				label: `${scopeName} profile delegation entries`,
				type: "record",
				keyLabel: "Agent profile",
				keyOptions: profileKeyOptions(scope, profiles, rawConfig),
				description: "Add an existing Forge agent profile. Configured entries whose profile is currently missing remain visible so they can be removed; new missing-profile entries are rejected on save.",
				recordFields: [
					{ key: "enabled", label: "Enabled", type: "boolean" },
					{ key: "backend", label: "Backend override", type: "string", placeholder: "Inherit", maxLength: 128 },
					{ key: "timeoutMs", label: "Timeout override (ms)", type: "string", placeholder: "Inherit", maxLength: 16 },
				],
			},
		],
	};
}

export function scopedConfigToContributionValues(rawConfig: Record<string, unknown>): UiContributionTabDescriptor["values"] {
	const profiles: Record<string, unknown> = {};
	if (isPlainRecord(rawConfig.profiles)) {
		for (const [profileId, rawProfile] of Object.entries(rawConfig.profiles)) {
			const profile = isPlainRecord(rawProfile) ? rawProfile : {};
			profiles[profileId] = {
				enabled: profile.enabled === true,
				backend: typeof profile.backend === "string" ? profile.backend : "",
				timeoutMs: isValidSubagentTimeoutMs(profile.timeoutMs) ? String(profile.timeoutMs) : "",
			};
		}
	}
	return {
		backend: typeof rawConfig.backend === "string" ? rawConfig.backend : "",
		timeoutMs: isValidSubagentTimeoutMs(rawConfig.timeoutMs) ? rawConfig.timeoutMs : "",
		allowAgentInvocationWithoutApproval: booleanChoice(rawConfig.allowAgentInvocationWithoutApproval),
		summaryInToolDescription: booleanChoice(rawConfig.summaryInToolDescription),
		profiles,
	};
}

export function buildSubagentSettingsTabs(
	ctx: ExtensionContext,
	profiles: readonly ForgeProfileSummary[],
): UiContributionTabDescriptor[] {
	const scopes: SettingsScope[] = ctx.isProjectTrusted() ? ["project", "global"] : ["global"];
	return scopes.map((scope) => {
		const configPath = configPathForScope(ctx, scope);
		const read = readConfigFile(configPath);
		const rawConfig = read.value;
		return {
			tabId: tabIdForScope(scope),
			title: `Subagents · ${scope === "project" ? "Project" : "Global"}`,
			icon: SUBAGENT_SETTINGS_ICON,
			schema: buildSubagentSettingsSchema(scope, configPath, profiles, rawConfig, read.error),
			values: scopedConfigToContributionValues(rawConfig),
		};
	});
}

export function createForgeSubagentSettingsContribution(
	transport: UiContributionTransport,
	contextProvider: () => ExtensionContext | undefined,
	profileCatalogProvider: ProfileCatalogProvider,
): UiContributionProvider {
	return new UiContributionProvider(transport, {
		providerId: "pi-forge-subagents-settings",
		async handle(operation, payload, requestContext): Promise<UiContributionPortResult> {
			const ctx = contextProvider();
			if (!ctx) return { ok: false, error: "No active subagent session context." };
			const profiles = await profileCatalogProvider();
			if (requestContext.signal.aborted) return { ok: false, error: "Subagent settings provider session changed." };
			if (operation === "listContributions") {
				return { ok: true, data: { tabs: buildSubagentSettingsTabs(ctx, profiles) } };
			}
			if (operation === "writeValues") {
				const request = payload as { tabId?: unknown; patch?: unknown };
				const scope = scopeForTabId(request.tabId);
				if (!scope) return { ok: true, data: { ok: false, errors: { tabId: "Unknown contribution tab." } } };
				if (!request.patch || typeof request.patch !== "object" || Array.isArray(request.patch)) {
					return { ok: true, data: { ok: false, errors: { patch: "Settings must be an object." } } };
				}
				return {
					ok: true,
					data: writeScopedSubagentSettings(ctx, scope, request.patch as Record<string, unknown>, profiles),
				};
			}
			return { ok: false, error: `Unknown UI contribution operation: ${operation}` };
		},
	});
}

export function writeScopedSubagentSettings(
	ctx: ExtensionContext,
	scope: SettingsScope,
	values: Record<string, unknown>,
	profiles: readonly ForgeProfileSummary[],
): UiWriteValuesResponse {
	if (scope === "project" && !ctx.isProjectTrusted()) {
		return { ok: false, errors: { scope: "Project subagent settings require a trusted project." } };
	}
	const path = configPathForScope(ctx, scope);
	const read = readConfigFile(path);
	if (read.error) return { ok: false, errors: { config: `${read.error} Fix the JSON file on disk before saving.` } };
	const current = read.value;
	const errors = validateScopedValues(scope, values, profiles, current);
	if (Object.keys(errors).length > 0) return { ok: false, errors };

	const next = { ...current };
	if (Object.hasOwn(values, "backend")) applyOptionalString(next, "backend", values.backend);
	if (Object.hasOwn(values, "timeoutMs")) applyOptionalTimeout(next, "timeoutMs", values.timeoutMs);
	if (Object.hasOwn(values, "allowAgentInvocationWithoutApproval")) applyBooleanChoice(next, "allowAgentInvocationWithoutApproval", values.allowAgentInvocationWithoutApproval);
	if (Object.hasOwn(values, "summaryInToolDescription")) applyBooleanChoice(next, "summaryInToolDescription", values.summaryInToolDescription);

	if (Object.hasOwn(values, "profiles")) {
		const submittedProfiles = values.profiles as Record<string, Record<string, unknown>>;
		const currentProfiles = isPlainRecord(current.profiles) ? current.profiles : {};
		const nextProfiles: Record<string, unknown> = {};
		for (const [profileId, row] of Object.entries(submittedProfiles)) {
			const existingRow = isPlainRecord(currentProfiles[profileId]) ? currentProfiles[profileId] : {};
			const nextRow: Record<string, unknown> = { ...existingRow, enabled: row.enabled === true };
			if (typeof row.backend === "string" && row.backend.trim()) nextRow.backend = row.backend.trim();
			else delete nextRow.backend;
			if (row.timeoutMs !== "" && row.timeoutMs !== null && row.timeoutMs !== undefined) nextRow.timeoutMs = Number(row.timeoutMs);
			else delete nextRow.timeoutMs;
			nextProfiles[profileId] = nextRow;
		}
		if (Object.keys(nextProfiles).length > 0) next.profiles = nextProfiles;
		else delete next.profiles;
	}

	writeConfigFile(path, next);
	return { ok: true, values: scopedConfigToContributionValues(next) };
}

function validateScopedValues(
	scope: SettingsScope,
	values: Record<string, unknown>,
	profiles: readonly ForgeProfileSummary[],
	current: Record<string, unknown>,
): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const key of Object.keys(values)) {
		if (!(FORM_FIELDS as readonly string[]).includes(key)) errors[key] = "Unknown setting.";
	}
	if (values.backend !== undefined && typeof values.backend !== "string") errors.backend = "Backend must be a string.";
	else if (typeof values.backend === "string" && values.backend.length > 128) errors.backend = "Backend must be at most 128 characters.";
	if (values.timeoutMs !== undefined && values.timeoutMs !== "" && !isValidSubagentTimeoutMs(values.timeoutMs)) {
		errors.timeoutMs = `Timeout must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`;
	}
	for (const key of ["allowAgentInvocationWithoutApproval", "summaryInToolDescription"] as const) {
		if (values[key] !== undefined && !["inherit", "enabled", "disabled"].includes(String(values[key]))) {
			errors[key] = "Choose Inherit, Enabled, or Disabled.";
		}
	}
	if (!Object.hasOwn(values, "profiles")) return errors;
	if (!isPlainRecord(values.profiles)) {
		errors.profiles = "Profiles must be a table of entries.";
		return errors;
	}
	const catalogCounts = profileCatalogCounts(scope, profiles);
	const existingIds = new Set(isPlainRecord(current.profiles) ? Object.keys(current.profiles) : []);
	for (const [profileId, rawRow] of Object.entries(values.profiles)) {
		const catalogMatches = catalogCounts.get(profileId) ?? 0;
		if (catalogMatches > 1 && !existingIds.has(profileId)) {
			errors[`profiles.${profileId}`] = `Agent profile ${profileId} is ambiguous because the ${scope} Forge profile catalog contains duplicate IDs.`;
			continue;
		}
		if (catalogMatches !== 1 && !existingIds.has(profileId)) {
			errors[`profiles.${profileId}`] = `Agent profile ${profileId} does not exist in the ${scope} Forge profile catalog.`;
			continue;
		}
		if (!existingIds.has(profileId) && !profileId.startsWith(`${scope}:`)) {
			errors[`profiles.${profileId}`] = `New entries must use a ${scope}:<id> selector.`;
			continue;
		}
		if (!isPlainRecord(rawRow)) {
			errors[`profiles.${profileId}`] = "Profile settings must be an object.";
			continue;
		}
		for (const key of Object.keys(rawRow)) {
			if (!(PROFILE_FIELDS as readonly string[]).includes(key)) errors[`profiles.${profileId}.${key}`] = "Unknown profile setting.";
		}
		if (typeof rawRow.enabled !== "boolean") errors[`profiles.${profileId}.enabled`] = "Enabled must be a boolean.";
		if (rawRow.backend !== undefined && typeof rawRow.backend !== "string") errors[`profiles.${profileId}.backend`] = "Backend must be a string.";
		else if (typeof rawRow.backend === "string" && rawRow.backend.length > 128) errors[`profiles.${profileId}.backend`] = "Backend must be at most 128 characters.";
		if (rawRow.timeoutMs !== undefined && rawRow.timeoutMs !== "" && !isValidSubagentTimeoutMs(Number(rawRow.timeoutMs))) {
			errors[`profiles.${profileId}.timeoutMs`] = `Timeout must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`;
		}
	}
	return errors;
}

function profileKeyOptions(
	scope: SettingsScope,
	profiles: readonly ForgeProfileSummary[],
	rawConfig: Record<string, unknown>,
): Array<{ value: string; label: string }> {
	const catalogCounts = profileCatalogCounts(scope, profiles);
	const options = profiles
		.filter((profile) => profile.scope === scope && catalogCounts.get(canonicalProfileId(profile)) === 1)
		.map((profile) => {
			const value = canonicalProfileId(profile);
			const name = profile.name && profile.name !== profile.profileId ? ` — ${profile.name}` : "";
			const health = profile.usable ? "" : " · unavailable";
			return { value, label: `${scope === "project" ? "Project" : "Global"} · ${profile.profileId}${name}${health}` };
		});
	const known = new Set(options.map((option) => option.value));
	if (isPlainRecord(rawConfig.profiles)) {
		for (const profileId of Object.keys(rawConfig.profiles)) {
			if (!known.has(profileId)) {
				const unavailableReason = (catalogCounts.get(profileId) ?? 0) > 1
					? "configured profile is ambiguous"
					: "configured profile not found";
				options.push({ value: profileId, label: `${profileId} · ${unavailableReason}` });
			}
		}
	}
	return options;
}

function profileCatalogCounts(scope: SettingsScope, profiles: readonly ForgeProfileSummary[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const profile of profiles) {
		if (profile.scope !== scope) continue;
		const selector = canonicalProfileId(profile);
		counts.set(selector, (counts.get(selector) ?? 0) + 1);
	}
	return counts;
}

function canonicalProfileId(profile: ForgeProfileSummary): string {
	return `${profile.scope}:${profile.profileId}`;
}

function tabIdForScope(scope: SettingsScope): string {
	return scope === "project" ? PROJECT_SUBAGENT_SETTINGS_TAB_ID : GLOBAL_SUBAGENT_SETTINGS_TAB_ID;
}

function scopeForTabId(tabId: unknown): SettingsScope | undefined {
	if (tabId === PROJECT_SUBAGENT_SETTINGS_TAB_ID) return "project";
	if (tabId === GLOBAL_SUBAGENT_SETTINGS_TAB_ID) return "global";
	return undefined;
}

function configPathForScope(ctx: ExtensionContext, scope: SettingsScope): string {
	return scope === "project" ? projectSubagentsConfigPath(ctx.cwd) : globalSubagentsConfigPath();
}

function booleanChoice(value: unknown): "inherit" | "enabled" | "disabled" {
	return value === true ? "enabled" : value === false ? "disabled" : "inherit";
}

function booleanOptions(): Array<{ value: string; label: string }> {
	return BOOLEAN_CHOICES.map((option) => ({ ...option }));
}

function applyOptionalString(file: Record<string, unknown>, key: string, value: unknown): void {
	if (typeof value === "string" && value.trim()) file[key] = value.trim();
	else delete file[key];
}

function applyOptionalTimeout(file: Record<string, unknown>, key: string, value: unknown): void {
	if (value === "" || value === null || value === undefined) delete file[key];
	else file[key] = Number(value);
}

function applyBooleanChoice(file: Record<string, unknown>, key: string, value: unknown): void {
	if (value === "enabled") file[key] = true;
	else if (value === "disabled") file[key] = false;
	else delete file[key];
}

function readConfigFile(path: string): ConfigReadResult {
	if (!existsSync(path)) return { value: {} };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isPlainRecord(parsed)) return { value: {}, error: `${path} must contain a JSON object.` };
		return { value: parsed };
	} catch (error) {
		return { value: {}, error: `Failed to parse ${path}: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function writeConfigFile(path: string, file: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
