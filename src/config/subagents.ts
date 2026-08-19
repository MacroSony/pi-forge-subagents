import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
}

export interface ForgeSubagentSettings {
	backend?: string;
	backendSource?: "project" | "global" | "built-in";
	timeoutMs: number;
	timeoutSource: "project" | "global" | "built-in";
	allowAgentInvocationWithoutApproval?: boolean;
	profiles: Record<string, ForgeSubagentProfileSettings>;
	warnings: string[];
}

export interface ResolvedSubagentProfilePolicy {
	enabled: boolean;
	backend: { id: string; source: "project" | "global" | "built-in" | "explicit" };
	timeout: { milliseconds: number; source: "project" | "global" | "built-in" | "explicit" };
}

export function isValidSubagentTimeoutMs(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= MIN_SUBAGENT_TIMEOUT_MS && value <= MAX_SUBAGENT_TIMEOUT_MS;
}

export function projectSubagentsConfigPath(cwd: string): string {
	return join(cwd, ".pi", "forge", "subagents.json");
}

export function globalSubagentsConfigPath(): string {
	const env = process.env.PI_FORGE_GLOBAL_FORGE_DIR ?? process.env.PI_FORGE_GLOBAL_DIR;
	const root = env ?? homedir();
	return join(root, ".pi", "forge", "subagents.json");
}

export function loadForgeSubagentSettings(ctx: ExtensionContext): ForgeSubagentSettings {
	const settings: ForgeSubagentSettings = {
		timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
		timeoutSource: "built-in",
		profiles: Object.create(null) as Record<string, ForgeSubagentProfileSettings>,
		warnings: [],
	};

	const global = readConfigFile(globalSubagentsConfigPath(), settings.warnings);
	if (global) applySection(global, "global", settings);

	// Only trusted projects may contribute project-local subagent settings.
	if (ctx.isProjectTrusted()) {
		const project = readConfigFile(projectSubagentsConfigPath(ctx.cwd), settings.warnings);
		if (project) applySection(project, "project", settings);
	} else {
		settings.warnings.push("pi-forge-subagents: project is not trusted; project subagents.json settings are ignored.");
	}

	return settings;
}

export function resolveSubagentProfilePolicy(
	settings: ForgeSubagentSettings,
	profileId: string,
	explicitBackend?: string,
): ResolvedSubagentProfilePolicy {
	const profile = settings.profiles[profileId] ?? {};
	const enabled = profile.enabled === true;
	const backendId = explicitBackend ?? profile.backend ?? settings.backend ?? DEFAULT_SUBAGENT_BACKEND_ID;
	const backendSource: ResolvedSubagentProfilePolicy["backend"]["source"] = explicitBackend
		? "explicit"
		: profile.backend !== undefined && profile.backend !== null
			? "project"
			: settings.backend !== undefined
				? settings.backendSource ?? "global"
				: "built-in";
	const timeoutMs = profile.timeoutMs ?? settings.timeoutMs;
	const timeoutSource: ResolvedSubagentProfilePolicy["timeout"]["source"] = profile.timeoutMs !== undefined && profile.timeoutMs !== null
		? "project"
		: settings.timeoutSource;
	return { enabled, backend: { id: backendId, source: backendSource }, timeout: { milliseconds: timeoutMs, source: timeoutSource } };
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

function applySection(raw: Record<string, unknown>, source: "project" | "global", settings: ForgeSubagentSettings): void {
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
	if (typeof raw.allowAgentInvocationWithoutApproval === "boolean") {
		settings.allowAgentInvocationWithoutApproval = raw.allowAgentInvocationWithoutApproval;
	}
	if (raw.profiles && typeof raw.profiles === "object" && !Array.isArray(raw.profiles)) {
		for (const [profileId, value] of Object.entries(raw.profiles as Record<string, unknown>)) {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				settings.warnings.push(`pi-forge-subagents: profile ${profileId} settings must be an object; ignored.`);
				continue;
			}
			const record = value as Record<string, unknown>;
			const current = settings.profiles[profileId] ?? {};
			if (typeof record.enabled === "boolean") current.enabled = record.enabled;
			if (record.backend === null) current.backend = null;
			else if (typeof record.backend === "string" && record.backend.trim()) current.backend = record.backend.trim();
			if (record.timeoutMs === null) current.timeoutMs = null;
			else if (isValidSubagentTimeoutMs(record.timeoutMs)) current.timeoutMs = record.timeoutMs;
			settings.profiles[profileId] = current;
		}
	}
}
