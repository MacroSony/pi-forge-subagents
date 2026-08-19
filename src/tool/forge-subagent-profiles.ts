import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ForgeProfileSummary } from "@zihanw/pi-forge/subagent";
import type { ForgeHostSession } from "../host/session.ts";
import { DEFAULT_SUBAGENT_TIMEOUT_MS, loadForgeSubagentSettings, resolveSubagentProfilePolicy, type ForgeSubagentSettings, type ResolvedSubagentProfilePolicy } from "../config/subagents.ts";

const MAX_VISIBLE_DESCRIPTION_CHARS = 1_000;
const ForgeSubagentProfilesParameters = Type.Object({});

export interface ForgeSubagentProfileSummary {
	id: string;
	name?: string;
	description?: string;
	model: { provider: string; id: string };
	thinkingLevel: string;
	promptStack: string | null;
	backend: { id: string; source: string };
	timeout: { milliseconds: number; source: string };
	status: "ready" | "unavailable";
	diagnostics: Array<{ level: string; message: string; field?: string }>;
}

export interface ForgeSubagentProfilesToolDetails {
	status: "completed" | "disabled";
	invocationToolAvailable: boolean;
	approvalMode: "interactive" | "unattended-config";
	defaultBackend?: { id: string; source: string };
	timeout: { milliseconds: number; source: string };
	configWarnings: string[];
	profiles: ForgeSubagentProfileSummary[];
}

export function registerForgeSubagentProfilesTool(
	pi: ExtensionAPI,
	sessionProvider: () => ForgeHostSession | undefined,
): void {
	pi.registerTool({
		name: "forge_subagent_profiles",
		label: "Forge Subagent Profiles",
		description: [
			"List Pi Forge agent profiles explicitly enabled for subagent delegation, with descriptions, execution settings, and active approval mode.",
			"Use this before forge_subagent when the user has not already specified a profile ID.",
			"This reads only the host profile catalog and performs no provider request or subagent prompt preparation.",
		].join(" "),
		parameters: ForgeSubagentProfilesParameters,

		async execute(_toolCallId, _params, _signal, _onUpdate, ctx): Promise<AgentToolResult<ForgeSubagentProfilesToolDetails>> {
			if (!ctx.isProjectTrusted()) {
				return result(
					"Subagent profile discovery is disabled because the project is not trusted.",
					{
						status: "disabled",
						invocationToolAvailable: false,
						approvalMode: "interactive",
						timeout: { milliseconds: DEFAULT_SUBAGENT_TIMEOUT_MS, source: "built-in" },
						configWarnings: [],
						profiles: [],
					},
				);
			}

			const session = sessionProvider();
			if (!session) {
				return result(
					"Subagent profile discovery is unavailable because no pi-forge host session is connected.",
					{
						status: "disabled",
						invocationToolAvailable: false,
						approvalMode: "interactive",
						timeout: { milliseconds: DEFAULT_SUBAGENT_TIMEOUT_MS, source: "built-in" },
						configWarnings: [],
						profiles: [],
					},
				);
			}

			const settings = loadForgeSubagentSettings(ctx);
			const invocationToolAvailable = pi.getActiveTools().includes("forge_subagent");
			const approvalMode = settings.allowAgentInvocationWithoutApproval ? "unattended-config" : "interactive";
			const defaultBackend = settings.backend
				? { id: settings.backend, source: settings.backendSource ?? "global" }
				: { id: "pi-subprocess-readonly", source: "built-in" as const };
			const timeout = { milliseconds: settings.timeoutMs, source: settings.timeoutSource };
			let summaries: ForgeSubagentProfileSummary[] = [];
			let configWarnings = [...settings.warnings];
			try {
				const profiles = await session.listProfiles();
				const hostIds = new Set(profiles.map(canonicalProfileId));
				for (const configuredKey of Object.keys(settings.profiles)) {
					if (settings.profiles[configuredKey]?.enabled !== true) continue;
					if (hostIds.has(configuredKey)
						|| hostIds.has(`project:${configuredKey}`)
						|| hostIds.has(`global:${configuredKey}`)) continue;
					configWarnings.push(`pi-forge-subagents: configured profile key "${configuredKey}" does not match any host profile.`);
				}
				summaries = profiles.flatMap((profile) => {
					const canonicalId = canonicalProfileId(profile);
					const policy = resolveSubagentProfilePolicy(settings, canonicalId);
					return policy.enabled ? [summarizeProfile(profile, policy)] : [];
				});
			} catch (error) {
				return result(
					`Subagent profile discovery failed: ${error instanceof Error ? error.message : String(error)}`,
					{
						status: "disabled",
						invocationToolAvailable,
						approvalMode,
						defaultBackend,
						timeout,
						configWarnings,
						profiles: [],
					},
				);
			}

			return result(
				renderProfileCatalog(summaries, invocationToolAvailable, approvalMode, configWarnings, defaultBackend, timeout),
				{
					status: "completed",
					invocationToolAvailable,
					approvalMode,
					defaultBackend,
					timeout,
					configWarnings,
					profiles: summaries,
				},
			);
		},
	});
}

export function canonicalProfileId(profile: ForgeProfileSummary): string {
	return profile.scope === "global" ? `global:${profile.profileId}` : `project:${profile.profileId}`;
}

export function summarizeProfile(
	profile: ForgeProfileSummary,
	policy: ResolvedSubagentProfilePolicy,
): ForgeSubagentProfileSummary {
	return {
		id: canonicalProfileId(profile),
		name: profile.name,
		description: profile.description,
		model: structuredClone(profile.model),
		thinkingLevel: profile.thinkingLevel,
		promptStack: profile.promptStack,
		backend: structuredClone(policy.backend),
		timeout: structuredClone(policy.timeout),
		status: profile.usable ? "ready" : "unavailable",
		diagnostics: structuredClone(profile.diagnostics),
	};
}

export function renderProfileCatalog(
	profiles: readonly ForgeSubagentProfileSummary[],
	invocationToolAvailable: boolean,
	approvalMode: "interactive" | "unattended-config" = "interactive",
	configWarnings: readonly string[] = [],
	defaultBackend?: { id: string; source: string },
	timeout?: { milliseconds: number; source: string },
): string {
	if (profiles.length === 0) {
		return [
			`No Pi Forge agent profiles are enabled for subagent delegation. Parent invocation tool: ${invocationToolAvailable ? "active" : "inactive"}. Approval mode: ${approvalMode}.`,
			"Enable a profile explicitly with subagents.profiles.<id>.enabled: true.",
			...(defaultBackend ? [`Default backend: ${defaultBackend.id} (${defaultBackend.source}).`] : []),
			...(timeout ? [`Timeout: ${timeout.milliseconds} ms (${timeout.source}; best-effort host abort).`] : []),
			...configWarnings.map((warning) => `Configuration warning: ${warning}`),
		].join("\n");
	}

	const ready = profiles.filter((profile) => profile.status === "ready");
	const unavailable = profiles.filter((profile) => profile.status === "unavailable");
	const lines = [
		`Pi Forge subagent profiles: ${ready.length} ready, ${unavailable.length} unavailable.`,
		`Parent invocation tool: ${invocationToolAvailable ? "active" : "inactive; the current tool policy must permit forge_subagent before the main agent can invoke a profile"}.`,
		approvalMode === "unattended-config"
			? "Approval mode: unattended-config; exact backend preflight still runs, but forge_subagent may contact the provider without per-run human approval."
			: "Approval mode: interactive; a ready profile still undergoes exact backend preflight and per-run human approval.",
	];
	if (defaultBackend) lines.push(`Default backend: ${defaultBackend.id} (${defaultBackend.source}); the interactive forge_subagent backend parameter or /forge-agent --backend overrides it per run.`);
	if (timeout) lines.push(`Timeout: ${timeout.milliseconds} ms (${timeout.source}; best-effort host abort).`);
	if (configWarnings.length > 0) lines.push(...configWarnings.map((warning) => `Configuration warning: ${warning}`));

	if (ready.length > 0) {
		lines.push("", "Ready profiles:");
		for (const profile of ready) lines.push(...renderProfile(profile));
	}
	if (unavailable.length > 0) {
		lines.push("", "Unavailable profiles:");
		for (const profile of unavailable) lines.push(...renderProfile(profile, true));
	}

	return lines.join("\n");
}

function renderProfile(profile: ForgeSubagentProfileSummary, includeErrors = false): string[] {
	const title = `- ${profile.id}${profile.name ? ` — ${compact(profile.name)}` : ""}`;
	const description = profile.description ? truncate(compact(profile.description), MAX_VISIBLE_DESCRIPTION_CHARS) : "(no description provided)";
	const lines = [
		title,
		`  Description: ${description}`,
		`  Model: ${profile.model.provider}/${profile.model.id}; thinking: ${profile.thinkingLevel}; stack: ${profile.promptStack ?? "none"}`,
		`  Execution: backend ${profile.backend.id} (${profile.backend.source}); timeout ${profile.timeout.milliseconds} ms (${profile.timeout.source}; best-effort host abort)`,
	];
	if (includeErrors) {
		const errors = profile.diagnostics.filter((diagnostic) => diagnostic.level === "error");
		lines.push(`  Unavailable because: ${errors.map((diagnostic) => diagnostic.message).join("; ") || "profile resolution failed"}`);
	}
	return lines;
}

function result(text: string, details: ForgeSubagentProfilesToolDetails): AgentToolResult<ForgeSubagentProfilesToolDetails> {
	return { content: [{ type: "text", text }], details: structuredClone(details) };
}

function compact(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

const MAX_EMBEDDED_PROFILES = 8;
const MAX_EMBEDDED_SUMMARY_CHARS = 1_000;

export function renderEmbeddedSummaryText(summaries: readonly ForgeSubagentProfileSummary[]): string | undefined {
	if (summaries.length === 0) return undefined;
	const visible = summaries.slice(0, MAX_EMBEDDED_PROFILES);
	const lines = ["Enabled subagent profiles:"];
	for (const profile of visible) {
		lines.push(`- ${embeddedProfileLine(profile)}`);
	}
	if (summaries.length > visible.length) {
		lines.push(`- ... and ${summaries.length - visible.length} more enabled profile${summaries.length - visible.length === 1 ? "" : "s"} (forge_subagent_profiles lists all)`);
	}
	const text = lines.join("\n");
	return text.length <= MAX_EMBEDDED_SUMMARY_CHARS
		? text
		: `${text.slice(0, Math.max(0, MAX_EMBEDDED_SUMMARY_CHARS - 3))}...`;
}

function embeddedProfileLine(profile: ForgeSubagentProfileSummary): string {
	const label = profile.name ? `${profile.id} — ${compact(profile.name)}` : profile.id;
	const target = `${profile.model.provider}/${profile.model.id} · thinking ${profile.thinkingLevel} · stack ${profile.promptStack ?? "none"}`;
	const execution = `backend ${profile.backend.id} · ${profile.timeout.milliseconds}ms`;
	if (profile.status === "ready") return `${label}: ${target}; ${execution}`;
	const reason = profile.diagnostics.find((diagnostic) => diagnostic.level === "error")?.message ?? "profile resolution failed";
	return `${label}: ${target}; ${execution} (unavailable: ${compact(reason)})`;
}
