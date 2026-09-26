import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { UiContributionProvider } from "@zihanw/pi-forge/ui-contribution";
import type { ForgePrepareRequest } from "@zihanw/pi-forge/subagent";
import { ForgeHostSession } from "./host/session.ts";
import { createForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
import { registerForgeAgentCommand } from "./command/forge-agent.ts";
import { registerForgeSubagentTool } from "./tool/forge-subagent.ts";
import { registerForgeSubagentTaskTool } from "./tool/forge-subagent-task.ts";
import { backgroundTasksFor } from "./runtime/background-tasks.ts";
import { canonicalProfileId, registerForgeSubagentProfilesTool, renderEmbeddedSummaryText, summarizeProfile } from "./tool/forge-subagent-profiles.ts";
import { loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "./config/subagents.ts";
import { createForgeSubagentSettingsContribution } from "./ui-contribution/subagent-settings-contribution.ts";

export { ForgeHostSession } from "./host/session.ts";
export type { ForgeHostSessionOptions } from "./host/session.ts";
export { createForgeSubagentRuntime } from "./runtime/subagent-runtime.ts";
export type { ForgeSubagentPreparedRun, ForgeSubagentRuntime, ForgeSubagentPreparationResult } from "./runtime/subagent-runtime.ts";
export { registerForgeSubagentTool } from "./tool/forge-subagent.ts";
export { registerForgeSubagentTaskTool } from "./tool/forge-subagent-task.ts";
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
	let currentContext: any;
	let lifecycleGeneration = 0;
	let disposed = false;
	let settingsContribution: UiContributionProvider | undefined;
	let settingsContributionContext: any;
	let unregisterForgeAgent: (() => void) | undefined;
	const runtime = createForgeSubagentRuntime(() => session);

	function startSettingsContribution(ctx: any): void {
		settingsContribution?.stop();
		settingsContributionContext = ctx;
		settingsContribution = createForgeSubagentSettingsContribution(
			pi.events as never,
			() => settingsContributionContext,
			async () => session ? session.listProfiles() : [],
		);
		settingsContribution.start();
	}

	function stopSettingsContribution(): void {
		settingsContribution?.stop();
		settingsContribution = undefined;
		settingsContributionContext = undefined;
	}

	function startForgeAgentCommand(): void {
		unregisterForgeAgent?.();
		unregisterForgeAgent = registerForgeAgentCommand(
			pi,
			runtime,
			() => session,
			() => currentContext,
		);
	}

	function stopForgeAgentCommand(): void {
		unregisterForgeAgent?.();
		unregisterForgeAgent = undefined;
	}

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		if (disposed) return;
		const generation = ++lifecycleGeneration;
		backgroundTasksFor(runtime).clear();
		const cleanup = runtime.dispose();
		currentContext = ctx;
		stopForgeAgentCommand();
		stopSettingsContribution();
		session?.dispose();
		session = undefined;
		let connected: ForgeHostSession;
		try { connected = await ForgeHostSession.connect(pi.events as never); }
		catch (error) { if (generation === lifecycleGeneration && !disposed) throw error; else return; }
		await cleanup;
		const isCurrent = () => generation === lifecycleGeneration && !disposed;
		if (!isCurrent()) { connected.dispose(); return; }
		session = connected;
		startSettingsContribution(ctx);
		await refreshToolDescription(ctx, isCurrent);
		if (!isCurrent()) return;
		startForgeAgentCommand();
	});

	pi.on("session_tree", async (_event: unknown, ctx: any) => {
		currentContext = ctx;
	});

	pi.on("session_compact", async (_event: unknown, ctx: any) => {
		currentContext = ctx;
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		// Switching may be cancelled. Retain the valid current context until session_start replaces it.
		if (ctx) currentContext = ctx;
	});

	pi.on("session_before_fork", async (_event, ctx) => {
		if (ctx) currentContext = ctx;
	});

	pi.on("session_shutdown", async () => {
		lifecycleGeneration++;
		backgroundTasksFor(runtime).clear();
		stopForgeAgentCommand();
		currentContext = undefined;
		session?.dispose();
		session = undefined;
		stopSettingsContribution();
		await runtime.dispose();
	});

	pi.registerCommand("subagent", {
		description: "Legacy host smoke test helper: list Forge profiles and prepare delegated prompts without provider transport.",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (!trimmed.includes(" ")) {
				return ["help", "list", "plan"].filter((cmd) => cmd.startsWith(trimmed)).map((cmd) => ({ value: cmd, label: cmd }));
			}
			return null;
		},
		handler: async (args: string, ctx) => {
			const trimmed = args.trim();
			const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];
			if (command === "help") {
				ctx.ui.notify("Legacy host smoke test helper: /subagent list | plan <profile> [task]. For real subagent execution, use canonical /forge subagent (or /forge-agent).", "info");
				return;
			}
			if (!session) {
				ctx.ui.notify("pi-forge-subagents: no Forge host session (start a session first).", "warning");
				return;
			}
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
			ctx.ui.notify("Usage: /subagent list | plan <profile> [task] (legacy smoke helper; use canonical /forge subagent or /forge-agent for real execution)", "info");
		},
	});

	registerForgeSubagentProfilesTool(pi, () => session);
	registerForgeSubagentTaskTool(pi, runtime, () => session);
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
	startForgeAgentCommand();

	return {
		get session() {
			return session;
		},
		dispose() {
			disposed = true;
			backgroundTasksFor(runtime).clear();
			lifecycleGeneration++;
			stopForgeAgentCommand();
			currentContext = undefined;
			settingsContribution?.stop();
			settingsContribution = undefined;
			settingsContributionContext = undefined;
			session?.dispose();
			session = undefined;
			void runtime.dispose();
		},
	};
}
