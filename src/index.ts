import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ForgePrepareRequest } from "@zihanw/pi-forge/subagent";
import { ForgeHostSession } from "./host/session.ts";
import { createForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
import { registerForgeAgentCommand } from "./command/forge-agent.ts";
import { registerForgeSubagentTool } from "./tool/forge-subagent.ts";
import { canonicalProfileId, registerForgeSubagentProfilesTool, renderEmbeddedSummaryText, summarizeProfile } from "./tool/forge-subagent-profiles.ts";
import { loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "./config/subagents.ts";

export { ForgeHostSession } from "./host/session.ts";
export type { ForgeHostSessionOptions } from "./host/session.ts";
export { createForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
export type { ForgeSubagentPreparedRun, ForgeSubagentRuntime, ForgeSubagentPreparationResult } from "./runtime/subagent-runtime.ts";
export { registerForgeSubagentTool } from "./tool/forge-subagent.ts";
export type { ForgeSubagentToolDetails, ForgeSubagentApprovalReceipt } from "./tool/forge-subagent.ts";
export { registerForgeSubagentProfilesTool } from "./tool/forge-subagent-profiles.ts";
export type { ForgeSubagentProfileSummary, ForgeSubagentProfilesToolDetails } from "./tool/forge-subagent-profiles.ts";
export { registerForgeAgentCommand } from "./command/forge-agent.ts";
export { loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "./config/subagents.ts";
export type { ForgeSubagentSettings, ForgeSubagentProfileSettings, ResolvedSubagentProfilePolicy } from "./config/subagents.ts";

export interface ForgeSubagentsExtensionContext {
	session?: ForgeHostSession;
	dispose(): void;
}

/**
 * Pi extension entry point for the optional subagent integration.
 *
 * Discovers the active pi-forge host through `pi.events` using the versioned
 * `/subagent` host port, registers the `forge_subagent` tool with interactive
 * approval, and owns execution through @zihanw/pi-subagent-runtime. All
 * profile/stack/compile ownership stays in the main pi-forge host.
 */
export default function piForgeSubagents(pi: ExtensionAPI): ForgeSubagentsExtensionContext {
	let session: ForgeHostSession | undefined;
	const runtime = createForgeSubagentRuntime(() => session);

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		session?.dispose();
		session = await ForgeHostSession.connect(pi.events as never);
		await refreshToolDescription(ctx);
	});

	pi.on("session_shutdown", async () => {
		session?.dispose();
		session = undefined;
		await runtime.dispose();
	});

	pi.registerCommand("subagent", {
		description: "List Forge profiles and prepare delegated prompts through the active pi-forge host.",
		handler: async (args: string, ctx) => {
			if (!session) {
				ctx.ui.notify("pi-forge-subagents: no Forge host session (start a session first).", "warning");
				return;
			}
			const trimmed = args.trim();
			const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];
			if (command === "list") {
				const profiles = await session.listProfiles();
				ctx.ui.notify(profiles.map((profile) => `${profile.scope}:${profile.profileId}`).join("\n") || "No profiles.", "info");
				return;
			}
			if (command === "plan" && rest[0]) {
				const request: ForgePrepareRequest = {
					profile: rest[0],
					task: { text: rest.slice(1).join(" ") || "Delegate this task." },
					access: { level: "read-only", network: "deny", allowProcess: false },
					backend: {
						model: { provider: "unknown", id: "unknown" },
						thinkingLevel: "high",
						toolCatalog: [],
					},
				};
				const prepared = await session.prepare(request);
				ctx.ui.notify(prepared.systemPrompt || "(empty system prompt)", "info");
				return;
			}
			ctx.ui.notify("Usage: /subagent list | plan <profile> [task]", "info");
		},
	});

	registerForgeSubagentProfilesTool(pi, () => session);
	const refreshToolDescription = registerForgeSubagentTool(pi, runtime, {
		sessionProvider: () => session,
		summarize: async (ctx) => {
			const settings = loadForgeSubagentSettings(ctx);
			if (!settings.summaryInToolDescription) return undefined;
			const current = session;
			if (!current) return undefined;
			const profiles = await current.listProfiles();
			const enabled = profiles.flatMap((profile) => {
				const id = canonicalProfileId(profile);
				const policy = resolveSubagentProfilePolicy(settings, id);
				return policy.enabled ? [summarizeProfile(profile, policy)] : [];
			});
			return renderEmbeddedSummaryText(enabled);
		},
	});
	registerForgeAgentCommand(pi, runtime, () => session);

	return {
		get session() {
			return session;
		},
		dispose() {
			session?.dispose();
			session = undefined;
			void runtime.dispose();
		},
	};
}
