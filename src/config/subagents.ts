import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_SUBAGENT_BACKEND_ID = "pi-subprocess-readonly";
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 60_000;
export const MIN_SUBAGENT_TIMEOUT_MS = 1_000;
export const MAX_SUBAGENT_TIMEOUT_MS = 3_600_000;

export interface ForgeSubagentProfileSettings {
	enabled?: boolean;
	backend?: string | null;
	timeoutMs?: number | null;
	/** undefined inherits the top-level value; non-boolean config is stored as false (fail-closed). */
	allowAgentModelOverrides?: boolean;
}

export interface ForgeSubagentSettings {
	backend?: string;
	backendSource?: "project" | "global" | "built-in";
	timeoutMs: number;
	timeoutSource: "project" | "global" | "built-in";
	allowAgentInvocationWithoutApproval?: boolean;
	/** Top-level default for agent-supplied per-run model (provider/id) and thinkingLevel overrides. */
	allowAgentModelOverrides?: boolean;
	summaryInToolDescription?: boolean;
	summaryInToolDescriptionSource?: "project" | "global";
	allowedWorkingDirectories?: string[];
	profiles: Record<string, ForgeSubagentProfileSettings>;
	/** File provenance per profile entry key: which config file last defined it. */
	profilesSource: Record<string, "project" | "global">;
	warnings: string[];
}

export interface ResolvedSubagentProfilePolicy {
	enabled: boolean;
	backend: { id: string; source: "project" | "global" | "built-in" | "explicit" };
	timeout: { milliseconds: number; source: "project" | "global" | "built-in" | "explicit" };
	/**
	 * Permits an agent-supplied single-run model (provider/id) and/or thinkingLevel
	 * override. It never selects a model by itself; omitted fields use the profile.
	 */
	allowAgentModelOverrides: boolean;
}

export function isValidSubagentTimeoutMs(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= MIN_SUBAGENT_TIMEOUT_MS && value <= MAX_SUBAGENT_TIMEOUT_MS;
}

export function projectSubagentsConfigPath(cwd: string): string {
	return join(cwd, ".pi", "forge", "subagents.json");
}

export function globalSubagentsConfigPath(): string {
	const forgeDir = process.env.PI_FORGE_GLOBAL_DIR;
	if (forgeDir) return join(forgeDir, "subagents.json");
	const root = process.env.PI_FORGE_GLOBAL_FORGE_DIR ?? homedir();
	return join(root, ".pi", "forge", "subagents.json");
}

export function projectLegacyForgeConfigPath(cwd: string): string {
	return join(cwd, ".pi", "forge", "config.json");
}

export function globalLegacyForgeConfigPath(): string {
	const forgeDir = process.env.PI_FORGE_GLOBAL_DIR;
	if (forgeDir) return join(forgeDir, "config.json");
	const root = process.env.PI_FORGE_GLOBAL_FORGE_DIR ?? homedir();
	return join(root, ".pi", "forge", "config.json");
}

export function loadForgeSubagentSettings(ctx: ExtensionContext): ForgeSubagentSettings {
	const settings: ForgeSubagentSettings = {
		timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
		timeoutSource: "built-in",
		summaryInToolDescription: false,
		allowAgentModelOverrides: false,
		profiles: Object.create(null) as Record<string, ForgeSubagentProfileSettings>,
		profilesSource: Object.create(null) as Record<string, "project" | "global">,
		warnings: [],
	};

	// Legacy config.json.subagents is read-only fallback material. Dedicated
	// subagents.json values win over legacy values. To keep legacy as a true
	// fallback, apply all legacy sections before any dedicated section.
	const globalBase = process.env.PI_FORGE_GLOBAL_DIR ?? join(process.env.PI_FORGE_GLOBAL_FORGE_DIR ?? homedir(), ".pi", "forge");

	const globalLegacy = readLegacySubagentsSection(globalLegacyForgeConfigPath(), settings.warnings);
	if (globalLegacy) applySection(globalLegacy, "global", settings, globalBase);

	const projectLegacy = ctx.isProjectTrusted()
		? readLegacySubagentsSection(projectLegacyForgeConfigPath(ctx.cwd), settings.warnings)
		: undefined;
	if (projectLegacy) applySection(projectLegacy, "project", settings, ctx.cwd);

	const global = readConfigFile(globalSubagentsConfigPath(), settings.warnings);
	if (global) applySection(global, "global", settings, globalBase);

	if (ctx.isProjectTrusted()) {
		const project = readConfigFile(projectSubagentsConfigPath(ctx.cwd), settings.warnings);
		if (project) applySection(project, "project", settings, ctx.cwd);
	} else {
		settings.warnings.push("pi-forge-subagents: project is not trusted; project subagents.json and config.json.subagents settings are ignored.");
	}

	return settings;
}

export function resolveSubagentProfilePolicy(
	settings: ForgeSubagentSettings,
	profileId: string,
	explicitBackend?: string,
): ResolvedSubagentProfilePolicy {
	const profile = profileSettingsFor(settings, profileId) ?? {};
	const profileSource = resolveProfileSource(settings, profileId);
	const enabled = profile.enabled === true;
	const backendId = explicitBackend ?? profile.backend ?? settings.backend ?? DEFAULT_SUBAGENT_BACKEND_ID;
	const backendSource: ResolvedSubagentProfilePolicy["backend"]["source"] = explicitBackend
		? "explicit"
		: profile.backend !== undefined && profile.backend !== null
			? profileSource
			: settings.backend !== undefined
				? settings.backendSource ?? "global"
				: "built-in";
	const timeoutMs = profile.timeoutMs ?? settings.timeoutMs;
	const timeoutSource: ResolvedSubagentProfilePolicy["timeout"]["source"] = profile.timeoutMs !== undefined && profile.timeoutMs !== null
		? profileSource
		: settings.timeoutSource;
	const allowAgentModelOverrides = profile.allowAgentModelOverrides ?? settings.allowAgentModelOverrides ?? false;
	return {
		enabled,
		backend: { id: backendId, source: backendSource },
		timeout: { milliseconds: timeoutMs, source: timeoutSource },
		allowAgentModelOverrides: allowAgentModelOverrides === true,
	};
}

export function profileAuthorizationHint(settings: ForgeSubagentSettings, profileId: string): string | undefined {
	if (!profileId.startsWith("global:")) return undefined;
	const bare = profileId.slice("global:".length);
	if (!bare || settings.profiles[bare]?.enabled !== true) return undefined;
	return `Configuration key "${bare}" authorizes only project:${bare}; use "global:${bare}" in subagents.json to authorize this global profile.`;
}

/** Delegation never uses the host catalog's project-first bare fallback. */
export function canonicalDelegationProfileId(profileId: string): string {
	return profileId.startsWith("project:") || profileId.startsWith("global:")
		? profileId
		: `project:${profileId}`;
}

export function isAllowedWorkingDirectory(
	settings: ForgeSubagentSettings,
	targetCwd: string,
	parentCwd: string,
): boolean {
	let canonicalTarget: string;
	try {
		canonicalTarget = realpathSync(targetCwd);
	} catch {
		canonicalTarget = resolve(targetCwd);
	}
	let canonicalParent: string;
	try {
		canonicalParent = realpathSync(parentCwd);
	} catch {
		canonicalParent = resolve(parentCwd);
	}
	if (canonicalTarget === canonicalParent) return true;
	const allowlist = settings.allowedWorkingDirectories ?? [];
	return allowlist.includes(canonicalTarget);
}

function profileSettingsKey(settings: ForgeSubagentSettings, profileId: string): string | undefined {
	// Prefer exact canonical keys, then support bare project IDs in project-scoped
	// selectors. Bare IDs never imply global delegation authority.
	if (Object.hasOwn(settings.profiles, profileId)) return profileId;
	const canonical = profileId.startsWith("project:") || profileId.startsWith("global:")
		? profileId
		: `project:${profileId}`;
	if (Object.hasOwn(settings.profiles, canonical)) return canonical;
	if (profileId.startsWith("project:")) {
		const bare = profileId.slice("project:".length);
		if (Object.hasOwn(settings.profiles, bare)) return bare;
	}
	return undefined;
}

function profileSettingsFor(settings: ForgeSubagentSettings, profileId: string): ForgeSubagentProfileSettings | undefined {
	const key = profileSettingsKey(settings, profileId);
	return key === undefined ? undefined : settings.profiles[key];
}

/**
 * File provenance for the effective profile entry: which config file last
 * defined it. Mirrors profileSettingsKey so a bare global-defined key still
 * reports the global file as its source. Defaults to global for defensive
 * fallback (the base layer; project overrides it when defined).
 */
function resolveProfileSource(settings: ForgeSubagentSettings, profileId: string): "project" | "global" {
	const key = profileSettingsKey(settings, profileId);
	if (key !== undefined && Object.hasOwn(settings.profilesSource, key)) return settings.profilesSource[key];
	return "global";
}

function readConfigFile(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warnings.push(`pi-forge-subagents: failed to read ${path}; settings ignored. ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`pi-forge-subagents: ${path} must be a JSON object; settings ignored.`);
		return undefined;
	}
	return raw as Record<string, unknown>;
}

function readLegacySubagentsSection(path: string, warnings: string[]): Record<string, unknown> | undefined {
	const raw = readConfigFile(path, warnings);
	if (!raw) return undefined;
	if (raw.subagents === undefined) return undefined;
	if (!raw.subagents || typeof raw.subagents !== "object" || Array.isArray(raw.subagents)) {
		warnings.push(`pi-forge-subagents: ${path} subagents must be a JSON object; ignored.`);
		return undefined;
	}
	warnings.push(`pi-forge-subagents: ${path} uses legacy config.json.subagents as read-only fallback; prefer subagents.json.`);
	return raw.subagents as Record<string, unknown>;
}

function applySection(raw: Record<string, unknown>, source: "project" | "global", settings: ForgeSubagentSettings, baseDir: string): void {
	if (typeof raw.backend === "string" && raw.backend.trim()) {
		settings.backend = raw.backend.trim();
		settings.backendSource = source;
	}
	if (isValidSubagentTimeoutMs(raw.timeoutMs)) {
		settings.timeoutMs = raw.timeoutMs;
		settings.timeoutSource = source;
	} else if (raw.timeoutMs !== undefined) {
		settings.warnings.push(`pi-forge-subagents: ${source} timeoutMs must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS}; ignored.`);
	}
	if (Object.hasOwn(raw, "allowAgentInvocationWithoutApproval")) {
		if (typeof raw.allowAgentInvocationWithoutApproval === "boolean") {
			settings.allowAgentInvocationWithoutApproval = raw.allowAgentInvocationWithoutApproval;
		} else {
			settings.allowAgentInvocationWithoutApproval = false;
			settings.warnings.push(`pi-forge-subagents: ${source} allowAgentInvocationWithoutApproval must be boolean; set to false.`);
		}
	}
	if (Object.hasOwn(raw, "allowAgentModelOverrides")) {
		if (typeof raw.allowAgentModelOverrides === "boolean") {
			settings.allowAgentModelOverrides = raw.allowAgentModelOverrides;
		} else {
			settings.allowAgentModelOverrides = false;
			settings.warnings.push(`pi-forge-subagents: ${source} allowAgentModelOverrides must be boolean; set to false.`);
		}
	}
	if (typeof raw.summaryInToolDescription === "boolean") {
		settings.summaryInToolDescription = raw.summaryInToolDescription;
		settings.summaryInToolDescriptionSource = source;
	} else if (raw.summaryInToolDescription !== undefined) {
		settings.warnings.push(`pi-forge-subagents: ${source} summaryInToolDescription must be boolean; ignored.`);
	}
	if (raw.allowedWorkingDirectories !== undefined) {
		if (!Array.isArray(raw.allowedWorkingDirectories)) {
			settings.allowedWorkingDirectories = [];
			settings.warnings.push(`pi-forge-subagents: ${source} allowedWorkingDirectories must be an array of strings; external targets disabled.`);
		} else {
			const validDirs: string[] = [];
			for (const item of raw.allowedWorkingDirectories) {
				if (typeof item !== "string" || !item.trim()) {
					settings.warnings.push(`pi-forge-subagents: ${source} allowedWorkingDirectories entries must be non-empty strings; ignored.`);
					continue;
				}
				const trimmed = item.trim();
				const expanded = trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
				const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
				try {
					const canonical = realpathSync(resolved);
					const stat = statSync(canonical);
					if (!stat.isDirectory()) {
						settings.warnings.push(`pi-forge-subagents: ${source} allowedWorkingDirectories entry "${item}" is not a directory; ignored.`);
						continue;
					}
					if (!validDirs.includes(canonical)) {
						validDirs.push(canonical);
					}
				} catch {
					settings.warnings.push(`pi-forge-subagents: ${source} allowedWorkingDirectories entry "${item}" is not an existing directory; ignored.`);
				}
			}
			// A higher-priority explicit list replaces, rather than unions with,
			// lower-priority grants. In particular [] can revoke global targets.
			settings.allowedWorkingDirectories = validDirs;
		}
	}
	if (raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)) {
		for (const [profileId, value] of Object.entries(raw.profiles as Record<string, unknown>)) {
			if (source === "global" && !isScopedProfileId(profileId)) {
				pushWarningOnce(
					settings.warnings,
					`pi-forge-subagents: bare global profile key "${profileId}" authorizes only project:${profileId}; use "global:${profileId}" to authorize the global profile.`,
				);
			}
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				settings.warnings.push(`pi-forge-subagents: profile ${profileId} settings must be an object; ignored.`);
				continue;
			}
			const record = value as Record<string, unknown>;
			const current = settings.profiles[profileId] ?? {};
			if (typeof record.enabled === "boolean") current.enabled = record.enabled;
			if (record.backend === null) current.backend = null;
			else if (typeof record.backend === "string" && record.backend.trim()) current.backend = record.backend.trim();
			if (Object.hasOwn(record, "allowAgentModelOverrides")) {
				if (typeof record.allowAgentModelOverrides === "boolean") {
					current.allowAgentModelOverrides = record.allowAgentModelOverrides;
				} else {
					current.allowAgentModelOverrides = false;
					settings.warnings.push(`pi-forge-subagents: ${source} profile ${profileId} allowAgentModelOverrides must be boolean; set to false.`);
				}
			}
			if (record.timeoutMs === null) current.timeoutMs = null;
			else if (isValidSubagentTimeoutMs(record.timeoutMs)) current.timeoutMs = record.timeoutMs;
			settings.profiles[profileId] = current;
			settings.profilesSource[profileId] = source;
		}
	}
}

function isScopedProfileId(profileId: string): boolean {
	return profileId.startsWith("project:") || profileId.startsWith("global:");
}

function pushWarningOnce(warnings: string[], warning: string): void {
	if (!warnings.includes(warning)) warnings.push(warning);
}
