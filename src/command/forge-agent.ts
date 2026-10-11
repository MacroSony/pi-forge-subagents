import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { contributeForgeCommand } from "@zihanw/pi-forge/command-contribution";
import { loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "../config/subagents.ts";
import type { ForgeHostSession } from "../host/session.ts";
import type { AgentResponse } from "../contract/index.ts";
import { backgroundTasksFor } from "../runtime/background-tasks.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRunHandle, ForgeSubagentRuntime } from "../runtime/subagent-runtime.ts";
import { FORGE_THINKING_LEVELS, isForgeThinkingLevel, parseForgeSubagentModel, requestForgeSubagentApproval } from "../tool/forge-subagent.ts";
import { canonicalProfileId, summarizeProfile } from "../tool/forge-subagent-profiles.ts";
import { recordedUsageTaskIds, renderSubagentUsageReport, subagentUsageTasks, usageTaskLabels } from "../usage/report.ts";
import { trySubagentView, withSubagentDialog } from "../ui/dialog-gate.ts";
import { plainSubagentText } from "../ui/plain-text.ts";
import { subagentViewScopeGuard } from "../ui/view-scope.ts";
import { showReadOnlyView, type ReadOnlyView } from "../ui/read-only-view.ts";
import type { BackgroundTaskStatus, BackgroundTaskResult } from "../runtime/background-tasks.ts";

const registeredApis = new WeakSet<ExtensionAPI>();
export const FORGE_AGENT_COMMAND_DESCRIPTION = "Plan, run, continue, or inspect human-approved subagent tasks";

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

		if (command === "contexts") {
			if (rawRest.trim()) { ctx.ui.notify("Usage: /forge-agent contexts", "warning"); return; }
			try {
				const contexts = backgroundTasksFor(runtime).contexts(ctx);
				await showText(ctx, "pi-forge retained contexts", contexts.map((c) => `${c.id}: ${c.profileId} ${c.model.provider}/${c.model.id} thinking:${c.thinkingLevel} cwd:${c.cwd}`).join("\n") || "No retained contexts in this parent session.");
			} catch (error) { ctx.ui.notify(`pi-forge-subagents: ${error instanceof Error ? error.message : String(error)}`, "error"); }
			return;
		}

		if (command === "usage") {
			const parsed = parseUsageArgs(rawRest);
			if (!parsed.ok) { ctx.ui.notify(parsed.error, "warning"); return; }
			try {
				const scope = parsed.branch ? "branch" : "session";
				const entries = parsed.branch ? ctx.sessionManager.getBranch() : ctx.sessionManager.getEntries();
				const pending = branchUsageBackground(runtime, ctx);
				const report = renderSubagentUsageReport(entries, pending, parsed.taskId, scope);
				const running = pending.filter((r) => !r.task.collected && (r.task.status === "running" || r.task.status === "starting")).length;
				const ready = pending.filter((r) => !r.task.collected && r.task.status !== "running" && r.task.status !== "starting").length;
				const summary = ctx.hasUI && typeof ctx.ui.custom === "function" && !parsed.taskId
					? `${report.split("\n\nTask index")[0]}\n\nLive on accessible launch branch: ${running} running; ${ready} completed/uncollected (excluded from recorded totals).\nLive usage/cache/estimated cost coverage may be incomplete or unknown; see task details.\nLive/pending details remain launch-branch gated. Viewing never collects, claims usage, or starts a model.`
					: report;
				await showHumanView(ctx, {
					title: `pi-forge subagent usage — ${scope}`,
					summary,
					...(!parsed.taskId ? { tasks: subagentUsageTasks(entries, pending).map((task) => ({
						...task, detail: () => {
							// Refresh the gate on Enter; a branch/session switch cannot reuse live output/usage.
							const currentEntries = parsed.branch ? ctx.sessionManager.getBranch() : ctx.sessionManager.getEntries();
							return renderSubagentUsageReport(currentEntries, branchUsageBackground(runtime, ctx), task.id, scope);
						},
					})) } : {}),
				});
			} catch (error) {
				ctx.ui.notify(`pi-forge-subagents: usage: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			return;
		}

		if (command === "status") {
			const tokens = tokenize(rawRest);
			if (tokens.length > 1) {
				ctx.ui.notify("Subcommand 'status' accepts at most one task ID argument.", "warning");
				return;
			}
			const taskId = tokens[0]?.token ? stripQuotes(tokens[0].token) : undefined;
			await showStatus(runtime, ctx, taskId);
			return;
		}

		if (command === "result") {
			const tokens = tokenize(rawRest);
			if (tokens.length === 0) {
				ctx.ui.notify("Usage: /forge-agent result <id>", "warning");
				return;
			}
			if (tokens.length > 1) {
				ctx.ui.notify("Subcommand 'result' accepts exactly one task ID argument.", "warning");
				return;
			}
			const taskId = stripQuotes(tokens[0]!.token);
			await showResult(runtime, ctx, taskId);
			return;
		}

		if (command === "cancel") {
			const tokens = tokenize(rawRest);
			if (tokens.length === 0) {
				ctx.ui.notify("Usage: /forge-agent cancel <id>", "warning");
				return;
			}
			if (tokens.length > 1) {
				ctx.ui.notify("Subcommand 'cancel' accepts exactly one task ID argument.", "warning");
				return;
			}
			const taskId = stripQuotes(tokens[0]!.token);
			await handleCancel(runtime, ctx, taskId);
			return;
		}

		if (command === "release") {
			const tokens = tokenize(rawRest);
			if (tokens.length === 0) {
				ctx.ui.notify("Usage: /forge-agent release <context-or-task-id>", "warning");
				return;
			}
			if (tokens.length > 1) {
				ctx.ui.notify("Subcommand 'release' accepts exactly one context or finished-task ID argument.", "warning");
				return;
			}
			const continueId = stripQuotes(tokens[0]!.token);
			await handleRelease(runtime, ctx, continueId);
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
		let prepared: ForgeSubagentPreparedRun | undefined = undefined;
		try {
			// CLI invocations are always human-approved; pass unattended: false even if project config has allowAgentInvocationWithoutApproval: true.
			const preparation = await runtime.prepare(parsed.profile, parsed.task, ctx, {
				backendId: parsed.backend,
				timeoutMs: undefined,
				cwd: parsed.cwd,
				unattended: false,
				keepContext: parsed.keepContext,
				continueId: parsed.continueId,
				model: parsed.model,
				thinkingLevel: parsed.thinkingLevel,
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
			if (parsed.background) {
				const bgManager = backgroundTasksFor(runtime);
				const targetCwd = prepared.cwd;
				const status = await bgManager.launch(prepared, ctx);
				prepared = undefined;
				await showText(ctx, `pi-forge subagent background: ${parsed.profile}`, [
					`Background task launched: ${status.id}`,
					`Run ID: ${status.id}`,
					`Profile: ${status.profileId}`,
					`Target CWD: ${status.cwd ?? targetCwd ?? "(parent workspace)"}`,
					`Status: ${status.status}`,
					"",
					`Use '/forge-agent status ${status.id}' to check progress,`,
					`'/forge-agent result ${status.id}' to inspect completed output, or`,
					`'/forge-agent cancel ${status.id}' to terminate.`,
				].join("\n"));
				return;
			}
			const targetCwd = prepared.cwd;
			const response = await runtime.execute(prepared, ctx, ctx.signal);
			prepared = undefined;
			runtime.takeReport?.(response.runId);
			await showText(ctx, `pi-forge subagent result: ${parsed.profile}`, renderResponse(response, targetCwd));
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
			if (trimmed === "") {
				const defaultCommands = ["backends", "config", "help", "list", "plan", "run"];
				return defaultCommands.map((cmd) => ({ value: cmd, label: cmd }));
			}
			const allCommands = ["backends", "cancel", "config", "contexts", "help", "list", "plan", "release", "result", "run", "status", "usage"];
			const matches = allCommands.filter((cmd) => cmd.startsWith(trimmed));
			return matches.length > 0 ? matches.map((cmd) => ({ value: cmd, label: cmd })) : null;
		}

		const match = prefix.match(/^\s*(\S+)([\s\S]*)$/);
		if (!match) return null;
		const command = match[1]!;
		const rest = match[2]!;

		if (command === "plan" || command === "run") {
			return await completePlanRunArguments(runtime, sessionProvider, contextProvider, rest, prefix, command);
		}

		if (command === "usage") {
			const ctx = contextProvider?.();
			if (!ctx) return null;
			try {
				const tokens = tokenize(rest);
				const fragment = /\s$/.test(prefix) ? "" : tokens.at(-1)?.token ?? "";
				const completed = /\s$/.test(prefix) ? tokens : tokens.slice(0, -1);
				const parsed = parseUsageArgs(completed.map((t) => t.token).join(" "));
				if (!parsed.ok) return null;
				const base = prefix.slice(0, prefix.length - fragment.length);
				const results: AutocompleteItem[] = [];
				if (!parsed.branch && "--branch".startsWith(fragment)) results.push({ value: `${base}--branch`, label: "--branch", description: "Current-branch recorded receipts only (default: session)" });
				if (!parsed.taskId && !fragment.startsWith("-")) {
					const entries = parsed.branch ? ctx.sessionManager.getBranch() : ctx.sessionManager.getEntries();
					const ids = [...new Set([...recordedUsageTaskIds(entries), ...branchUsageBackground(runtime, ctx).filter((r) => !r.task.collected).map((r) => r.task.id)])];
					const labels = usageTaskLabels(ids);
					results.push(...ids.filter((id) => id.startsWith(fragment) || labels.get(id)!.startsWith(fragment)).map((id) => ({ value: `${base}${labels.get(id)!}`, label: labels.get(id)!, description: `${parsed.branch ? "Current-branch" : "Session"} subagent usage (read-only)` })));
				}
				return results.length ? results : null;
			} catch { return null; }
		}

		if (command === "cancel" || command === "result" || command === "status") {
			return completeBackgroundTaskCompletions(runtime, contextProvider, rest, prefix);
		}

		return null;
	};
}

function completeBackgroundTaskCompletions(
	runtime: ForgeSubagentRuntime,
	contextProvider: (() => ExtensionContext | undefined) | undefined,
	rest: string,
	fullPrefix: string,
): AutocompleteItem[] | null {
	const trimmed = rest.trimStart();
	if (trimmed.includes(" ") && !/\s$/.test(trimmed)) {
		return null;
	}
	const ctx = contextProvider?.();
	if (!ctx) return null;
	try {
		const bgManager = backgroundTasksFor(runtime);
		const tasks = bgManager.status(ctx);
		const fragment = trimmed;
		const base = fullPrefix.slice(0, fullPrefix.length - fragment.length);
		const matches = tasks.filter((t) => t.id.startsWith(fragment));
		return matches.length > 0
			? matches.map((t) => ({
					value: `${base}${t.id}`,
					label: t.id,
					description: `${t.profileId} (${t.status})`,
			  }))
			: null;
	} catch {
		return null;
	}
}

interface TokenSpan {
	token: string;
	start: number;
	end: number;
}

function tokenize(str: string): TokenSpan[] {
	const tokens: TokenSpan[] = [];
	let i = 0;
	const n = str.length;

	while (i < n) {
		while (i < n && /\s/.test(str[i]!)) i++;
		if (i >= n) break;

		const start = i;
		let inQuote: string | null = null;

		while (i < n) {
			const char = str[i]!;
			if (inQuote) {
				if (char === inQuote) {
					inQuote = null;
				}
				i++;
			} else if (char === '"' || char === "'") {
				inQuote = char;
				i++;
			} else if (/\s/.test(char)) {
				break;
			} else {
				i++;
			}
		}

		tokens.push({
			token: str.slice(start, i),
			start,
			end: i,
		});
	}

	return tokens;
}

function stripQuotes(str: string): string {
	if (str.length >= 2) {
		const first = str[0];
		const last = str[str.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return str.slice(1, -1);
		}
	}
	return str;
}

export type ParsedUsageArgs = { ok: true; branch: boolean; taskId?: string } | { ok: false; error: string };
export function parseUsageArgs(raw: string): ParsedUsageArgs {
	const error = "Usage: /forge-agent usage [short-task-id] [--branch] (default: all recorded Subagents receipts in this session)";
	let branch = false;
	let taskId: string | undefined;
	for (const { token } of tokenize(raw)) {
		if (token === "--branch") {
			if (branch) return { ok: false, error };
			branch = true;
		} else {
			const id = stripQuotes(token);
			if (taskId !== undefined || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return { ok: false, error };
			taskId = id;
		}
	}
	return { ok: true, branch, ...(taskId !== undefined ? { taskId } : {}) };
}

function hasTaskStarted(completedTokens: readonly TokenSpan[]): boolean {
	let hasProfile = false;
	for (let i = 0; i < completedTokens.length; i++) {
		const t = completedTokens[i]!.token;
		if (t === "--") return true;
		if (t === "--backend" || t === "--cwd" || t === "--continue" || t === "--model" || t === "--thinking") {
			if (i + 1 < completedTokens.length) i++;
			continue;
		}
		if (t.startsWith("--backend=") || t.startsWith("--cwd=") || t.startsWith("--continue=") || t.startsWith("--model=") || t.startsWith("--thinking=")) continue;
		if (t === "--keep-context" || t.startsWith("--keep-context=") || t === "--background") continue;
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
	command: "plan" | "run",
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
	if (lastCompleted?.token === "--thinking" || fragment.startsWith("--thinking=")) {
		const eq = fragment.startsWith("--thinking=");
		const partial = eq ? fragment.slice("--thinking=".length) : fragment;
		const matches = FORGE_THINKING_LEVELS.filter((level) => level.startsWith(partial));
		return matches.length ? matches.map((level) => ({ value: `${base}${eq ? "--thinking=" : ""}${level}`, label: level })) : null;
	}
	if (lastCompleted?.token === "--model" || fragment.startsWith("--model=")) {
		const eq = fragment.startsWith("--model=");
		const partial = eq ? fragment.slice("--model=".length) : fragment;
		const matches = (ctx?.modelRegistry.getAvailable() ?? []).map((model) => `${model.provider}/${model.id}`).filter((id) => id.startsWith(partial));
		return matches.length ? matches.map((id) => ({ value: `${base}${eq ? "--model=" : ""}${id}`, label: id })) : null;
	}
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
	let modelConsumed = false;
	let thinkingConsumed = false;
	let cwdConsumed = false;
	let continueConsumed = false;
	let keepContextConsumed = false;
	let backgroundConsumed = false;
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
		if (t === "--model" || t === "--thinking") {
			if (t === "--model") modelConsumed = true; else thinkingConsumed = true;
			if (completedTokens[i + 1]) i++;
			continue;
		}
		if (t.startsWith("--model=")) { modelConsumed = true; continue; }
		if (t.startsWith("--thinking=")) { thinkingConsumed = true; continue; }
		if (t === "--cwd") {
			if (completedTokens[i + 1]) {
				cwdConsumed = true;
				i++;
			}
			continue;
		}
		if (t.startsWith("--cwd=")) {
			cwdConsumed = true;
			continue;
		}
		if (t === "--continue") {
			if (completedTokens[i + 1]) {
				continueConsumed = true;
				i++;
			}
			continue;
		}
		if (t.startsWith("--continue=")) {
			continueConsumed = true;
			continue;
		}
		if (t === "--keep-context" || t.startsWith("--keep-context=")) {
			keepContextConsumed = true;
			continue;
		}
		if (t === "--background") {
			backgroundConsumed = true;
			continue;
		}
		if (!t.startsWith("--")) {
			profileConsumed = true;
			continue;
		}
	}

	const results: AutocompleteItem[] = [];

	const availableFlags: string[] = [];
	if (!modelConsumed) availableFlags.push("--model");
	if (!thinkingConsumed) availableFlags.push("--thinking", ...FORGE_THINKING_LEVELS.map((level) => `--thinking=${level}`));
	if (!backendConsumed) {
		availableFlags.push("--backend", "--backend=", ...backendIds.map((b) => `--backend=${b}`));
	}
	if (!cwdConsumed) {
		availableFlags.push("--cwd");
	}
	if (!keepContextConsumed) {
		availableFlags.push("--keep-context");
	}
	if (!continueConsumed) {
		availableFlags.push("--continue");
	}
	if (command === "run" && !backgroundConsumed) {
		availableFlags.push("--background");
	}

	for (const flag of availableFlags) {
		if (flag.startsWith(fragment) && (!fragment.startsWith("--backend=") || flag.startsWith("--backend="))) {
			if (!results.some((r) => r.label === flag)) {
				results.push({ value: `${base}${flag}`, label: flag });
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

export interface ParsedPlanRunSuccess {
	ok: true;
	profile: string;
	task: string;
	backend?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	cwd?: string;
	keepContext?: boolean;
	continueId?: string;
	background?: boolean;
}

export type ParsedPlanRun =
	| ParsedPlanRunSuccess
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
	let model: { provider: string; id: string } | undefined;
	let thinkingLevel: string | undefined;
	let cwd: string | undefined;
	let keepContext = false;
	let continueId: string | undefined;
	let background = false;
	let taskStartIndex: number | undefined;

	const optionTokens = delimiterIndex !== -1 ? tokens.slice(0, delimiterIndex) : tokens;

	for (let i = 0; i < optionTokens.length; i++) {
		const t = optionTokens[i]!.token;
		if (t === "--backend") {
			const next = optionTokens[i + 1]?.token;
			if (!next || next.startsWith("--")) return { ok: false, error: "--backend requires a backend id value." };
			backend = stripQuotes(next);
			i++;
		} else if (t.startsWith("--backend=")) {
			const val = stripQuotes(t.slice("--backend=".length));
			if (!val) return { ok: false, error: "--backend requires a backend id value." };
			backend = val;
		} else if (t === "--model" || t.startsWith("--model=")) {
			const rawValue = t === "--model" ? optionTokens[++i]?.token : t.slice("--model=".length);
			if (!rawValue || rawValue.startsWith("--")) return { ok: false, error: "--model requires provider/id." };
			const parsed = parseForgeSubagentModel(stripQuotes(rawValue));
			if (!parsed.ok) return { ok: false, error: parsed.error };
			model = parsed.model;
		} else if (t === "--thinking" || t.startsWith("--thinking=")) {
			const rawValue = t === "--thinking" ? optionTokens[++i]?.token : t.slice("--thinking=".length);
			const value = rawValue ? stripQuotes(rawValue) : undefined;
			if (!isForgeThinkingLevel(value)) return { ok: false, error: `--thinking requires one of: ${FORGE_THINKING_LEVELS.join(", ")}.` };
			thinkingLevel = value;
		} else if (t === "--cwd") {
			const next = optionTokens[i + 1]?.token;
			if (!next || next.startsWith("--")) return { ok: false, error: "--cwd requires a path value." };
			const stripped = stripQuotes(next);
			if (!stripped.trim()) return { ok: false, error: "--cwd requires a path value." };
			cwd = stripped;
			i++;
		} else if (t.startsWith("--cwd=")) {
			const val = stripQuotes(t.slice("--cwd=".length));
			if (!val.trim()) return { ok: false, error: "--cwd requires a path value." };
			cwd = val;
		} else if (t === "--continue") {
			const next = optionTokens[i + 1]?.token;
			if (!next || next.startsWith("--")) return { ok: false, error: "--continue requires a continuation id value." };
			const stripped = stripQuotes(next);
			if (!stripped.trim()) return { ok: false, error: "--continue requires a continuation id value." };
			continueId = stripped;
			i++;
		} else if (t.startsWith("--continue=")) {
			const val = stripQuotes(t.slice("--continue=".length));
			if (!val.trim()) return { ok: false, error: "--continue requires a continuation id value." };
			continueId = val;
		} else if (t === "--keep-context") {
			keepContext = true;
		} else if (t.startsWith("--keep-context=")) {
			const val = t.slice("--keep-context=".length);
			keepContext = val !== "false";
		} else if (t === "--background") {
			background = true;
		} else if (t.startsWith("--")) {
			return { ok: false, error: `Unknown option: ${t}` };
		} else if (!profile) {
			profile = stripQuotes(t);
		} else if (delimiterIndex !== -1) {
			return { ok: false, error: `Unexpected argument before '--': ${t}` };
		} else {
			taskStartIndex = i;
			break;
		}
	}

	if (command === "plan" && background) {
		return { ok: false, error: "--background cannot be used with plan." };
	}

	if (continueId) {
		keepContext = true;
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
			if (t === "--model" || t.startsWith("--model=") || t === "--thinking" || t.startsWith("--thinking=")) {
				return { ok: false, error: "--model/--thinking must be specified before task; use '--' to pass flags to task." };
			}
			if (t === "--cwd" || t.startsWith("--cwd=")) {
				return { ok: false, error: "--cwd must be specified before task; use '--' to pass flags to task." };
			}
			if (t === "--continue" || t.startsWith("--continue=")) {
				return { ok: false, error: "--continue must be specified before task; use '--' to pass flags to task." };
			}
			if (t === "--keep-context" || t.startsWith("--keep-context=")) {
				return { ok: false, error: "--keep-context must be specified before task; use '--' to pass flags to task." };
			}
			if (t === "--background") {
				return { ok: false, error: "--background must be specified before task; use '--' to pass flags to task." };
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

	return {
		ok: true,
		profile,
		task,
		...(backend ? { backend } : {}),
		...(model ? { model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		...(cwd ? { cwd } : {}),
		...(keepContext ? { keepContext: true } : {}),
		...(continueId ? { continueId } : {}),
		...(background ? { background: true } : {}),
	};
}

/** status is session-wide; result(false) applies the launch-branch gate before displaying metadata. */
function branchUsageBackground(runtime: ForgeSubagentRuntime, ctx: ExtensionContext): BackgroundTaskResult[] {
	const manager = backgroundTasksFor(runtime);
	return manager.status(ctx).flatMap((task) => {
		try { return [manager.result(ctx, task.id, false)]; }
		catch { return []; } // Foreign launch branches must not expose even task labels/profiles.
	});
}

/** Uses only the public permitted metadata; legacy tasks honestly display unknown model/thinking. */
function taskLabel(task: BackgroundTaskStatus & { title?: string }): string {
	const execution = task.execution;
	// title is already projected by the manager's launch-branch gate. Never reconstruct task text.
	return `${task.title ? `${task.title} · ` : ""}${task.profileId} · ${execution ? `${execution.model.provider}/${execution.model.id}` : "model unknown"} · thinking:${execution?.thinkingLevel ?? "unknown"} · ${task.status}`;
}
function taskStatusText(task: BackgroundTaskStatus & { title?: string }): string {
	const lines = [
		`Task ID: ${task.id}`, ...(task.title ? [`Title: ${task.title}`] : []), `Profile: ${task.profileId}`, `Status: ${task.status}`,
		`Model: ${task.execution ? `${task.execution.model.provider}/${task.execution.model.id}` : "unknown"}`,
		`Thinking: ${task.execution?.thinkingLevel ?? "unknown"}`,
		`Target CWD: ${task.cwd ?? "(parent workspace)"}`, `Collected: ${task.collected ? "yes" : "no"}`,
	];
	if (task.execution) lines.push(`Mode: ${task.execution.mode}; context: ${task.execution.contextMode}`);
	if (task.continuationId) lines.push(`Retained context: ${task.continuationId}`);
	if (task.error) lines.push(`Error: ${task.error}`);
	return lines.join("\n");
}
function backgroundDetail(runtime: ForgeSubagentRuntime, ctx: ExtensionCommandContext, taskId: string): string {
	// This gate is required even when session-wide recorded history is available.
	const res = backgroundTasksFor(runtime).result(ctx, taskId, false);
	return [
		taskStatusText(res.task),
		res.response ? renderResponse(res.response, res.task.cwd) : `Task has no completed output (${res.task.status}).`,
		"Note: Native model usage accounting is reserved for tool-result collection; human inspection does not claim usage.",
	].join("\n\n");
}
async function showStatus(runtime: ForgeSubagentRuntime, ctx: ExtensionCommandContext, taskId?: string): Promise<void> {
	try {
		const tasks = backgroundTasksFor(runtime).status(ctx, taskId);
		if (taskId && !tasks[0]) { ctx.ui.notify(`pi-forge-subagents: unknown background task: ${taskId}`, "warning"); return; }
		const listing = tasks.length ? `Background tasks (${tasks.length}):\n\n${tasks.map((task) => `  ${!ctx.hasUI ? `${task.id} ` : ""}${taskLabel(task)}${task.cwd ? ` cwd:${task.cwd}` : ""} collected:${task.collected ? "yes" : "no"}${task.error ? ` (error: ${task.error})` : ""}${task.continuationId ? ` context:${task.continuationId}` : ""}`).join("\n")}` : "No background tasks in this parent session.";
		await showHumanView(ctx, {
			title: taskId ? `pi-forge background task: ${taskId}` : "pi-forge background tasks",
			summary: taskId ? taskStatusText(tasks[0]!) : ctx.hasUI && typeof ctx.ui.custom === "function" && tasks.length ? `Background tasks (${tasks.length}). Select a task for read-only output/details.\nOutput/usage remain launch-branch gated; viewing never collects or starts a model.` : listing,
			...(!taskId ? { tasks: tasks.map((task) => ({ id: task.id, label: taskLabel(task), detail: () => backgroundDetail(runtime, ctx, task.id) })) } : {}),
		});
	} catch (error) { ctx.ui.notify(`pi-forge-subagents: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}
async function showResult(runtime: ForgeSubagentRuntime, ctx: ExtensionCommandContext, taskId: string): Promise<void> {
	try { await showHumanView(ctx, { title: `pi-forge background result: ${taskId}`, summary: backgroundDetail(runtime, ctx, taskId) }); }
	catch (error) { ctx.ui.notify(`pi-forge-subagents: ${error instanceof Error ? error.message : String(error)}`, "error"); }
}

/** The whole summary → selector → detail flow takes the parent's single dialog slot once. */
async function showHumanView(ctx: ExtensionCommandContext, view: ReadOnlyView): Promise<void> {
	if (!ctx.hasUI) { await showReadOnlyView(ctx, view); return; }
	const opened = await trySubagentView(ctx.ui, () => showReadOnlyView(ctx, view));
	if (!opened.opened) ctx.ui.notify("pi-forge-subagents: another Subagent dialog is active or queued; retry this read-only view after it closes.", "info");
}

async function handleCancel(runtime: ForgeSubagentRuntime, ctx: ExtensionCommandContext, taskId: string): Promise<void> {
	const bgManager = backgroundTasksFor(runtime);
	try {
		const status = await bgManager.cancel(ctx, taskId);
		ctx.ui.notify(`pi-forge-subagents: background task ${status.id} cancelled (status: ${status.status}).`, "info");
	} catch (error) {
		ctx.ui.notify(`pi-forge-subagents: cancel failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function handleRelease(runtime: ForgeSubagentRuntime, ctx: ExtensionCommandContext, continueId: string): Promise<void> {
	if (typeof runtime.releaseContinuation !== "function") {
		ctx.ui.notify("pi-forge-subagents: runtime does not support continuation release.", "error");
		return;
	}
	try {
		const released = await backgroundTasksFor(runtime).release(ctx, continueId);
		ctx.ui.notify(`pi-forge-subagents: continuation ${released.continuationId} released.${released.taskId ? " Result remains available for collection." : ""}`, "info");
	} catch (error) {
		ctx.ui.notify(`pi-forge-subagents: release failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
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
		`Background completion notifications: ${settings.notifyOnComplete ? "enabled" : "disabled"} (human master; idle delivery may start a model turn)`,
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

function renderPlan(prepared: ForgeSubagentPreparedRun): string {
	const plan = prepared.plan;
	return [
		`Run ID: ${plan.runId}`,
		`Backend: ${plan.backendId}`,
		`Model: ${plan.model.provider}/${plan.model.id}`,
		`Target CWD: ${prepared.cwd ?? "(parent workspace)"}`,
		...(prepared.continueId ? [`Continuation ID: ${prepared.continueId}`] : []),
		`Keep context: ${prepared.keepContext ? "yes" : "no"}`,
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

function renderResponse(response: any, targetCwd?: string): string {
	const lines = [
		`Run ID: ${response.runId}`,
		`Status: ${response.status}`,
		`Backend: ${response.backendId}`,
		`Model: ${response.model.provider}/${response.model.id}`,
		`Target CWD: ${targetCwd ?? "(parent workspace)"}`,
		`Duration: ${response.durationMs} ms`,
		`Effective tools: ${response.effectiveToolIds.join(", ") || "none"}`,
	];
	if (response.continuationId) {
		lines.push(`Continuation ID: ${response.continuationId}`);
	}
	if (response.status === "failed") lines.push(`Error: ${response.error?.code ?? "unknown"}: ${response.error?.message ?? JSON.stringify(response.error ?? {})}`);
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
		"Foreground and background subagent commands (canonical: /forge subagent, compatible: /forge-agent):",
		"",
		"  /forge subagent help",
		"  /forge subagent list",
		"  /forge subagent backends",
		"  /forge subagent config",
		"  /forge subagent plan <profile> [options] [--] <task>",
		"  /forge subagent run <profile> [options] [--] <task>",
		"  /forge subagent usage [short-task-id] [--branch] (compatible: /forge-agent usage [short-task-id] [--branch])",
		"  /forge subagent status [id]",
		"  /forge subagent result <id>",
		"  /forge subagent cancel <id>",
		"  /forge subagent release <context-or-task-id>",
		"  /forge subagent contexts",
		"",
		"Subcommands:",
		"  help      Show this reference manual.",
		"  list      List enabled/eligible configured subagent profiles with scoped IDs and descriptions.",
		"  backends  Show registered subagent backends, capabilities, and isolation boundaries.",
		"  config    Print resolved subagent settings and profile policies with configuration sources.",
		"  plan      Prepare and validate the exact delegated request without provider transport.",
		"  run       Prepare the request, require interactive human approval, and execute one task (foreground or background).",
		"  usage     Read-only session totals for recorded Subagents receipts across all branches (main model excluded); --branch narrows history. Live/pending output and usage stay launch-branch gated. Add <id> for details or select a task in the UI. Legacy aliases/completion use the selected scope.",
		"  status    Select a session background task for read-only details (Enter; Esc returns), or check status by ID. Headless mode lists text.",
		"  result    Inspect background task output without claiming usage accounting.",
		"  cancel    Cancel an active background task by ID.",
		"  contexts  List retained context metadata without collecting output or usage.",
		"  release   Release retained context by context ID or finished background task ID; preserves results/usage.",
		"",
		"Options for plan and run:",
		"  --backend <id>, --backend=<id>      Select an execution backend before the task.",
		"  --cwd <path>, --cwd=<path>          Target working directory (supports quoted paths with spaces).",
		"  --keep-context                      Retain in-process child session after successful run for continuation.",
		"  --continue <id>, --continue=<id>    Continue a previously retained child session (implies keep-context).",
		"  --background                        Launch task in background after approval (run only).",
		"  --model <provider/id>                Override model for this approved run (not the saved profile).",
		"  --thinking <level>                   Override thinking; unsupported levels fail without clamping.",
		"  --                                  Delimiter marking the start of the task (allows literal flags in task).",
		"",
		"Legacy smoke helper note:",
		"  /subagent (list | plan) is a legacy low-level host smoke test helper without provider execution.",
		"  Use canonical /forge subagent (or /forge-agent) for real subagent execution.",
	].join("\n"));
}

async function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	if (ctx.hasUI) {
		const isCurrent = subagentViewScopeGuard(ctx);
		// Late run results and older info commands must not replace an approval.
		await withSubagentDialog(ctx.ui, async () => {
			if (!isCurrent()) { ctx.ui.notify("pi-forge-subagents: session/branch changed; repeat the command to view current information.", "warning"); return; }
			await ctx.ui.editor(plainSubagentText(title), plainSubagentText(text));
		});
		return;
	}
	console.log(plainSubagentText(text));
}
