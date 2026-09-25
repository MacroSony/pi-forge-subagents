import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { contributeForgeCommand } from "@zihanw/pi-forge/command-contribution";
import { loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "../config/subagents.ts";
import type { ForgeHostSession } from "../host/session.ts";
import type { ForgeSubagentRuntime } from "../runtime/subagent-runtime.ts";
import { requestForgeSubagentApproval } from "../tool/forge-subagent.ts";
import { canonicalProfileId, summarizeProfile } from "../tool/forge-subagent-profiles.ts";

const registeredApis = new WeakSet<ExtensionAPI>();
export const FORGE_AGENT_COMMAND_DESCRIPTION = "Plan or run a foreground human-approved agent profile";

export function registerForgeAgentCommand(
	pi: ExtensionAPI,
	runtime: ForgeSubagentRuntime,
	sessionProvider: () => ForgeHostSession | undefined,
	contextProvider?: () => ExtensionContext | undefined,
): () => void {
	const getArgumentCompletions = createForgeAgentArgumentCompletions(runtime, sessionProvider, contextProvider);
	const handler = createForgeAgentCommandHandler(runtime, sessionProvider);

	if (!registeredApis.has(pi)) {
		pi.registerCommand("forge-agent", {
			description: FORGE_AGENT_COMMAND_DESCRIPTION,
			getArgumentCompletions,
			handler,
		});
		registeredApis.add(pi);
	}

	let unsubscribeContribution: (() => void) | undefined;
	if (typeof contributeForgeCommand === "function" && pi.events && typeof (pi.events as any).on === "function") {
		unsubscribeContribution = contributeForgeCommand(pi.events as never, {
			name: "subagent",
			description: FORGE_AGENT_COMMAND_DESCRIPTION,
			handler: handler as never,
			getArgumentCompletions: getArgumentCompletions as never,
		});
	}

	return () => {
		unsubscribeContribution?.();
	};
}

export function createForgeAgentCommandHandler(
	runtime: ForgeSubagentRuntime,
	sessionProvider: () => ForgeHostSession | undefined,
	onContextUpdate?: (ctx: ExtensionCommandContext) => void,
): RegisteredCommand["handler"] {
	return async (args, ctx) => {
		onContextUpdate?.(ctx);
		const match = args.match(/^\s*(\S+)([\s\S]*)$/);
		const command = match ? match[1]! : "help";
		const rawRest = match ? match[2]! : "";

		if (command === "help" || command === "backends" || command === "config" || command === "list") {
			if (rawRest.trim().length > 0) {
				ctx.ui.notify(`Subcommand '${command}' does not accept arguments.`, "warning");
				return;
			}
			if (command === "backends") await showBackends(runtime, ctx);
			else if (command === "config") await showConfig(ctx);
			else if (command === "list") {
				const session = sessionProvider();
				if (!session) {
					ctx.ui.notify("pi-forge-subagents: no Forge host session (start a session first).", "warning");
					return;
				}
				await showList(session, ctx);
			} else {
				await showHelp(ctx);
			}
			return;
		}

		if (command !== "plan" && command !== "run") {
			ctx.ui.notify(`Unknown /forge-agent subcommand: ${command}`, "warning");
			return;
		}

		const session = sessionProvider();
		if (!session) {
			ctx.ui.notify("pi-forge-subagents: no Forge host session (start a session first).", "warning");
			return;
		}

		const parsed = parsePlanRunArgs(command, rawRest);
		if (!parsed.ok) {
			ctx.ui.notify(parsed.error, "warning");
			return;
		}
		if (command === "run" && !ctx.hasUI) {
			ctx.ui.notify("pi-forge-subagents: subagent execution requires interactive provider-egress confirmation; use /forge-agent plan in non-UI mode.", "error");
			return;
		}

		const settings = loadForgeSubagentSettings(ctx);
		for (const warning of settings.warnings) ctx.ui.notify(warning, "warning");

		ctx.ui.setStatus("pi-forge-subagent", ctx.ui.theme.fg("accent", command === "plan" ? "agent:preparing" : "agent:running"));
		let prepared: any = undefined;
		try {
			const preparation = await runtime.prepare(parsed.profile, parsed.task, ctx, {
				backendId: parsed.backend,
				timeoutMs: undefined,
			});
			if (!preparation.ok) {
				await showText(ctx, "pi-forge subagent diagnostics", renderDiagnostics(preparation.diagnostics));
				return;
			}
			prepared = preparation.prepared;
			if (command === "plan") {
				await showText(ctx, `pi-forge subagent plan: ${parsed.profile}`, renderPlan(prepared));
				await runtime.discard(prepared);
				prepared = undefined;
				return;
			}
			const approval = await requestForgeSubagentApproval(prepared, parsed.task, ctx, ctx.signal);
			if (!approval.approved) {
				await runtime.discard(prepared);
				prepared = undefined;
				ctx.ui.notify("pi-forge-subagents: subagent run cancelled before provider transport.", "info");
				return;
			}
			const response = await runtime.execute(prepared, ctx, ctx.signal);
			prepared = undefined;
			runtime.takeReport?.(response.runId);
			await showText(ctx, `pi-forge subagent result: ${parsed.profile}`, renderResponse(response));
		} catch (error) {
			if (prepared) await runtime.discard(prepared).catch(() => undefined);
			ctx.ui.notify(`pi-forge-subagents: subagent failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			ctx.ui.setStatus("pi-forge-subagent", undefined);
		}
	};
}

export function createForgeAgentArgumentCompletions(
	runtime: ForgeSubagentRuntime,
	sessionProvider: () => ForgeHostSession | undefined,
	contextProvider?: () => ExtensionContext | undefined,
): RegisteredCommand["getArgumentCompletions"] {
	return async (prefix) => {
		const trimmed = prefix.trimStart();
		if (!/\s/.test(trimmed) && !/\s$/.test(prefix)) {
			const firstTokens = ["backends", "config", "help", "list", "plan", "run"];
			const matches = firstTokens.filter((cmd) => cmd.startsWith(trimmed));
			return matches.length > 0 ? matches.map((cmd) => ({ value: cmd, label: cmd })) : null;
		}

		const match = prefix.match(/^\s*(\S+)([\s\S]*)$/);
		if (!match) return null;
		const command = match[1]!;
		const rest = match[2]!;

		if (command !== "plan" && command !== "run") {
			return null;
		}

		return await completePlanRunArguments(runtime, sessionProvider, contextProvider, rest, prefix);
	};
}

interface TokenSpan {
	token: string;
	start: number;
	end: number;
}

function tokenize(str: string): TokenSpan[] {
	const tokens: TokenSpan[] = [];
	const re = /\S+/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(str)) !== null) {
		tokens.push({
			token: match[0],
			start: match.index,
			end: match.index + match[0].length,
		});
	}
	return tokens;
}

function hasTaskStarted(completedTokens: readonly TokenSpan[]): boolean {
	let hasProfile = false;
	for (let i = 0; i < completedTokens.length; i++) {
		const t = completedTokens[i]!.token;
		if (t === "--") return true;
		if (t === "--backend") {
			if (i + 1 < completedTokens.length) i++;
			continue;
		}
		if (t.startsWith("--backend=")) continue;
		if (!t.startsWith("--")) {
			if (!hasProfile) {
				hasProfile = true;
				continue;
			}
			return true;
		}
		return true;
	}
	return false;
}

async function completePlanRunArguments(
	runtime: ForgeSubagentRuntime,
	sessionProvider: () => ForgeHostSession | undefined,
	contextProvider: (() => ExtensionContext | undefined) | undefined,
	rest: string,
	fullPrefix: string,
): Promise<AutocompleteItem[] | null> {
	const tokens = tokenize(rest);

	let fragment: string;
	let completedTokens: TokenSpan[];
	let base: string;

	if (/\s$/.test(fullPrefix)) {
		fragment = "";
		completedTokens = tokens;
		base = fullPrefix;
	} else if (tokens.length > 0) {
		const lastToken = tokens[tokens.length - 1]!;
		fragment = lastToken.token;
		completedTokens = tokens.slice(0, -1);
		base = fullPrefix.slice(0, fullPrefix.length - fragment.length);
	} else {
		fragment = "";
		completedTokens = [];
		base = fullPrefix;
	}

	// If task has already started, do not propose backend or delimiter completions.
	if (hasTaskStarted(completedTokens)) {
		return null;
	}

	// Check if the immediately preceding token was '--backend'.
	const lastCompleted = completedTokens[completedTokens.length - 1];
	const isCompletingBackendValue = lastCompleted?.token === "--backend";

	const ctx = contextProvider?.();
	const backendIds = ctx ? runtime.descriptors(ctx).map((d) => d.id) : runtime.backendIds();

	if (isCompletingBackendValue) {
		const matches = backendIds.filter((id) => id.startsWith(fragment));
		return matches.length > 0
			? matches.map((id) => ({
					value: `${base}${id}`,
					label: id,
			  }))
			: null;
	}

	let backendConsumed = false;
	let profileConsumed = false;
	for (let i = 0; i < completedTokens.length; i++) {
		const t = completedTokens[i]!.token;
		if (t === "--backend") {
			if (completedTokens[i + 1]) {
				backendConsumed = true;
				i++;
			}
			continue;
		}
		if (t.startsWith("--backend=")) {
			backendConsumed = true;
			continue;
		}
		if (!t.startsWith("--")) {
			profileConsumed = true;
			continue;
		}
	}

	const results: AutocompleteItem[] = [];

	if (!backendConsumed) {
		const flags = ["--backend", "--backend=", ...backendIds.map((b) => `--backend=${b}`)];
		for (const flag of flags) {
			if (flag.startsWith(fragment) && (!fragment.startsWith("--backend=") || flag.startsWith("--backend="))) {
				if (!results.some((r) => r.label === flag)) {
					results.push({ value: `${base}${flag}`, label: flag });
				}
			}
		}
	}

	if (profileConsumed && "--".startsWith(fragment)) {
		results.push({
			value: `${base}--`,
			label: "--",
		});
	}

	if (!profileConsumed) {
		const sessionBefore = sessionProvider();
		const ctxBefore = contextProvider?.();
		const trustBefore = ctxBefore ? (typeof ctxBefore.isProjectTrusted === "function" ? ctxBefore.isProjectTrusted() : (ctxBefore as any).isProjectTrusted === true) : false;

		if (sessionBefore && ctxBefore && trustBefore) {
			const cwdBefore = ctxBefore.cwd;
			const sessionIdBefore = ctxBefore.sessionManager?.getSessionId?.();
			const leafBefore = ctxBefore.sessionManager?.getLeafId?.();

			try {
				const profiles = await sessionBefore.listProfiles();
				const sessionAfter = sessionProvider();
				const ctxAfter = contextProvider?.();
				const trustAfter = ctxAfter ? (typeof ctxAfter.isProjectTrusted === "function" ? ctxAfter.isProjectTrusted() : (ctxAfter as any).isProjectTrusted === true) : false;

				if (
					sessionAfter === sessionBefore &&
					ctxAfter &&
					trustAfter &&
					ctxAfter.cwd === cwdBefore &&
					ctxAfter.sessionManager?.getSessionId?.() === sessionIdBefore &&
					ctxAfter.sessionManager?.getLeafId?.() === leafBefore
				) {
					const settings = loadForgeSubagentSettings(ctxAfter);
					for (const profile of profiles) {
						const canonicalId = canonicalProfileId(profile);
						const policy = resolveSubagentProfilePolicy(settings, canonicalId);
						if (!policy.enabled) continue;

						const candidates = [canonicalId];
						if (profile.scope === "project" && profile.profileId !== canonicalId) {
							candidates.push(profile.profileId);
						}
						for (const id of candidates) {
							if (id.startsWith(fragment) && !results.some((r) => r.label === id)) {
								results.push({
									value: `${base}${id}`,
									label: id,
									...(profile.description ? { description: profile.description } : {}),
								});
							}
						}
					}
				}
			} catch {
				// Ignore profile listing errors during completion
			}
		}
	}

	return results.length > 0 ? results : null;
}

export type ParsedPlanRun =
	| { ok: true; profile: string; task: string; backend?: string }
	| { ok: false; error: string };

export function parsePlanRunArgs(command: string, rawOrRest: string | string[]): ParsedPlanRun {
	const raw = Array.isArray(rawOrRest) ? rawOrRest.join(" ") : rawOrRest;
	const tokens = tokenize(raw);
	if (tokens.length === 0) {
		return { ok: false, error: `Usage: /forge-agent ${command} <profile> [--backend <id>] <task>` };
	}

	const delimiterIndex = tokens.findIndex((t) => t.token === "--");
	let profile: string | undefined;
	let backend: string | undefined;
	let taskStartIndex: number | undefined;

	const optionTokens = delimiterIndex !== -1 ? tokens.slice(0, delimiterIndex) : tokens;

	for (let i = 0; i < optionTokens.length; i++) {
		const t = optionTokens[i]!.token;
		if (t === "--backend") {
			const next = optionTokens[i + 1]?.token;
			if (!next || next.startsWith("--")) return { ok: false, error: "--backend requires a backend id value." };
			backend = next;
			i++;
		} else if (t.startsWith("--backend=")) {
			const val = t.slice("--backend=".length);
			if (!val) return { ok: false, error: "--backend requires a backend id value." };
			backend = val;
		} else if (t.startsWith("--")) {
			return { ok: false, error: `Unknown option: ${t}` };
		} else if (!profile) {
			profile = t;
		} else if (delimiterIndex !== -1) {
			return { ok: false, error: `Unexpected argument before '--': ${t}` };
		} else {
			taskStartIndex = i;
			break;
		}
	}

	if (!profile) {
		return {
			ok: false,
			error: delimiterIndex !== -1
				? `Usage: /forge-agent ${command} <profile> [--backend <id>] [--] <task>`
				: `Usage: /forge-agent ${command} <profile> [--backend <id>] <task>`,
		};
	}

	let task: string;
	if (delimiterIndex !== -1) {
		task = raw.slice(tokens[delimiterIndex]!.end).trim();
		if (!task) return { ok: false, error: `Usage: /forge-agent ${command} <profile> [--backend <id>] [--] <task>` };
	} else {
		if (taskStartIndex === undefined) {
			return { ok: false, error: `Usage: /forge-agent ${command} <profile> [--backend <id>] <task>` };
		}
		for (let i = taskStartIndex; i < tokens.length; i++) {
			const t = tokens[i]!.token;
			if (t === "--backend" || t.startsWith("--backend=")) {
				return { ok: false, error: "--backend must be specified before task; use '--' to pass flags to task." };
			}
			if (t.startsWith("--")) {
				return { ok: false, error: `Unknown option: ${t}` };
			}
		}
		task = raw.slice(tokens[taskStartIndex]!.start).trim();
		if (!task) {
			return { ok: false, error: `Usage: /forge-agent ${command} <profile> [--backend <id>] <task>` };
		}
	}

	return { ok: true, profile, task, ...(backend ? { backend } : {}) };
}

async function showList(session: ForgeHostSession, ctx: ExtensionCommandContext): Promise<void> {
	const settings = loadForgeSubagentSettings(ctx);
	const profiles = await session.listProfiles();
	const enabledSummaries = profiles.flatMap((profile) => {
		const canonicalId = canonicalProfileId(profile);
		const policy = resolveSubagentProfilePolicy(settings, canonicalId);
		return policy.enabled ? [summarizeProfile(profile, policy)] : [];
	});

	if (enabledSummaries.length === 0) {
		await showText(
			ctx,
			"pi-forge subagents",
			[
				"No Pi Forge agent profiles are enabled for subagent delegation.",
				"Enable a profile explicitly with subagents.profiles.<id>.enabled: true in your Forge settings.",
			].join("\n"),
		);
		return;
	}

	const lines = [
		`Enabled subagent profiles (${enabledSummaries.length}):`,
		"",
		...enabledSummaries.map((s) => {
			const label = s.name ? `${s.id} (${s.name})` : s.id;
			const desc = s.description ? ` - ${s.description}` : "";
			return `  ${label}${desc}`;
		}),
	];
	if (settings.warnings.length > 0) {
		lines.push("", "Configuration warnings:", ...settings.warnings.map((w) => `  ${w}`));
	}
	await showText(ctx, "pi-forge subagents", lines.join("\n"));
}

async function showConfig(ctx: ExtensionCommandContext): Promise<void> {
	const settings = loadForgeSubagentSettings(ctx);
	const lines = [
		"Resolved subagent settings:",
		`Backend: ${settings.backend ?? "(built-in pi-subprocess-readonly)"} (${settings.backendSource ?? "built-in"})`,
		`Timeout: ${settings.timeoutMs} ms (${settings.timeoutSource})`,
		`Allow unattended invocation: ${settings.allowAgentInvocationWithoutApproval ? "yes" : "no"}`,
		`Summary in tool description: ${settings.summaryInToolDescription ? "yes" : "no"} (${settings.summaryInToolDescriptionSource ?? "built-in"})`,
		"",
		"Profiles:",
	];
	const profileIds = Object.keys(settings.profiles);
	if (profileIds.length === 0) lines.push("  (none)");
	for (const profileId of profileIds) {
		const policy = resolveSubagentProfilePolicy(settings, profileId);
		lines.push(`  ${profileId}: enabled=${policy.enabled ? "yes" : "no"}, backend=${policy.backend.id} (${policy.backend.source}), timeout=${policy.timeout.milliseconds} ms (${policy.timeout.source})`);
	}
	if (settings.warnings.length > 0) {
		lines.push("", "Warnings:", ...settings.warnings.map((warning) => `  ${warning}`));
	}
	await showText(ctx, "pi-forge subagent config", lines.join("\n"));
}

async function showBackends(runtime: ForgeSubagentRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const settings = loadForgeSubagentSettings(ctx);
	const descriptors = runtime.descriptors(ctx);
	const lines = descriptors.map((descriptor) => [
		`${descriptor.id} @ ${descriptor.version}`,
		`  execution boundaries: ${descriptor.capabilities.executionBoundaries.join(", ")}`,
		`  read-only mount isolation: ${descriptor.capabilities.access.readOnlyMountIsolation ? "yes" : "no"}`,
		`  read-write mount isolation: ${descriptor.capabilities.access.readWriteMountIsolation ? "yes" : "no"}`,
		`  process isolation: ${descriptor.capabilities.access.processIsolation ? "yes" : "no"}`,
		`  prompt runtime: ${descriptor.capabilities.promptRuntimeFidelity}`,
		`  cancellation: ${descriptor.capabilities.cancellation ? "yes" : "no"}`,
		`  remote transport: ${descriptor.capabilities.remoteTransport ? "yes" : "no"}`,
	].join("\n"));
	lines.push(`Configured timeout: ${settings.timeoutMs} ms (${settings.timeoutSource}; best-effort host abort).`);
	if (settings.backend) lines.push(`Configured default backend: ${settings.backend} (${settings.backendSource ?? "global"}).`);
	for (const warning of settings.warnings) lines.push(`Configuration warning: ${warning}`);
	await showText(ctx, "pi-forge subagent backends", lines.join("\n\n") || "No subagent backends registered.");
}

function renderPlan(prepared: any): string {
	const plan = prepared.plan;
	return [
		`Backend: ${plan.backendId}`,
		`Model: ${plan.model.provider}/${plan.model.id}`,
		`Thinking: ${plan.thinkingLevel}`,
		`Profile: ${plan.profile.profileId}`,
		`Prompt stack: ${plan.profile.promptStackId ?? "none"}`,
		`Effective tools: ${plan.effectiveToolIds.join(", ") || "none"}`,
		`System prompt: ${plan.systemPrompt.length} chars`,
		`Messages: ${plan.messages.map((message: any) => `${message.role}${message.protectedTask ? " (protected task)" : ""}`).join(" -> ")}`,
		`Conversation fingerprint: ${plan.conversationFingerprint}`,
		`Execution fingerprint: ${plan.executionFingerprint}`,
		"Provider transport: not started; dry plan discarded.",
		"",
		"Diagnostics:",
		renderDiagnostics(prepared.diagnostics),
	].join("\n");
}

function renderResponse(response: any): string {
	const lines = [
		`Status: ${response.status}`,
		`Backend: ${response.backendId}`,
		`Model: ${response.model.provider}/${response.model.id}`,
		`Duration: ${response.durationMs} ms`,
		`Effective tools: ${response.effectiveToolIds.join(", ") || "none"}`,
	];
	if (response.status === "failed") lines.push(`Error: ${response.error.code}: ${response.error.message}`);
	if (response.status === "cancelled" || response.status === "timed-out") lines.push(`Reason: ${response.reason}`);
	if (response.status === "limit-reached") lines.push(`Reached limit: ${response.reachedLimit}`);
	if (response.output?.text) lines.push("", "Output:", response.output.text);
	return lines.join("\n");
}

function renderDiagnostics(diagnostics: readonly any[]): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	return diagnostics.map((item) => `${item.level.toUpperCase()} ${item.code}${item.path ? ` [${item.path}]` : ""}: ${item.message}`).join("\n");
}

async function showHelp(ctx: ExtensionCommandContext): Promise<void> {
	await showText(ctx, "pi-forge agent backend", [
		"Foreground subagent commands (canonical: /forge subagent, compatible: /forge-agent):",
		"",
		"  /forge subagent help",
		"  /forge subagent list",
		"  /forge subagent backends",
		"  /forge subagent config",
		"  /forge subagent plan <profile> [--backend <id>] [--] <task>",
		"  /forge subagent run <profile> [--backend <id>] [--] <task>",
		"",
		"Subcommands:",
		"  help      Show this reference manual.",
		"  list      List enabled/eligible configured subagent profiles with scoped IDs and descriptions.",
		"  backends  Show registered subagent backends, capabilities, and isolation boundaries.",
		"  config    Print resolved subagent settings and profile policies with configuration sources.",
		"  plan      Prepare and validate the exact delegated request without provider transport.",
		"  run       Prepare the request, require interactive human approval, and execute one foreground task.",
		"",
		"Options for plan and run:",
		"  --backend <id>, --backend=<id>  Select an execution backend before the task.",
		"  --                              Delimiter marking the start of the task (allows literal flags in task).",
		"",
		"Legacy smoke helper note:",
		"  /subagent (list | plan) is a legacy low-level host smoke test helper without provider execution.",
		"  Use canonical /forge subagent (or /forge-agent) for real subagent execution.",
	].join("\n"));
}

async function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	if (ctx.hasUI) {
		await ctx.ui.editor(title, text);
		return;
	}
	console.log(text);
}
