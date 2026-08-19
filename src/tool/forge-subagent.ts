import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentResponse, SubagentDiagnostic } from "@zihanw/pi-forge/subagent";
import type { ForgeSubagentPreparedRun, ForgeSubagentRuntime, SubagentBackendExecutionUpdate } from "../runtime/subagent-runtime.ts";
import { loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "../config/subagents.ts";
import type { ForgeHostSession } from "../host/session.ts";

const APPROVE = "Approve and run";
const VIEW_FULL_PROMPT = "View full prompt";
const REJECT = "Reject";
const MAX_PROGRESS_ITEMS = 100;

const ForgeSubagentParameters = Type.Object({
	profileId: Type.String({ minLength: 1, description: "ID of a Pi Forge agent profile enabled for subagent delegation." }),
	task: Type.String({ minLength: 1, description: "The focused task to delegate to the subagent." }),
	backend: Type.Optional(Type.String({ minLength: 1, description: "Backend ID to execute through (interactive runs only)." })),
});

export interface ForgeSubagentApprovalReceipt {
	required: boolean;
	approved: boolean;
	viewedFullPrompt: boolean;
	source: "none" | "human" | "trusted-project-config";
	executionFingerprint?: string;
	approvedAt?: string;
}

export interface ForgeSubagentToolDetails {
	status: "preparing" | "prepared" | "awaiting-approval" | "cancelled" | "running" | "completed" | "failed" | "timed-out" | "limit-reached";
	profileId: string;
	task: string;
	approval: ForgeSubagentApprovalReceipt;
	diagnostics: SubagentDiagnostic[];
	progress: SubagentBackendExecutionUpdate[];
	response?: AgentResponse;
}

export interface ForgeSubagentApprovalResult {
	approved: boolean;
	viewedFullPrompt: boolean;
}

export interface ForgeSubagentToolRegistrationOptions {
	sessionProvider: () => ForgeHostSession | undefined;
	backendModel?: { provider: string; id: string };
	thinkingLevel?: string;
	/** Optional dynamic tool-description summary; returned refresh callback re-registers when it changes. */
	summarize?: (ctx: ExtensionContext) => string | Promise<string | undefined> | undefined;
}

function toolContent(text: string): AgentToolResult<ForgeSubagentToolDetails>["content"] {
	return [{ type: "text", text }];
}

function textContent(result: AgentToolResult<unknown>): string {
	const part = Array.isArray(result.content) ? result.content[0] : undefined;
	if (part && part.type === "text") return part.text;
	return "";
}

function renderDiagnostics(diagnostics: readonly SubagentDiagnostic[]): string {
	if (diagnostics.length === 0) return "No diagnostics.";
	return diagnostics.map((diagnostic) => `${diagnostic.level.toUpperCase()}: ${diagnostic.message}`).join("\n");
}

function renderApprovalSummary(prepared: ForgeSubagentPreparedRun, task: string): string {
	const plan = prepared.plan;
	const lines = [
		`Subagent approval: ${plan.profile.profileId}`,
		`Task: ${task}`,
		`Backend: ${plan.backendId}`,
		`Model: ${plan.profile.profile.model.provider}/${plan.profile.profile.model.id}`,
		`Thinking: ${plan.profile.profile.thinkingLevel}`,
		`Prompt stack: ${plan.profile.promptStackId ?? "(none)"}`,
		`System prompt chars: ${plan.systemPrompt.length}`,
		`Messages: ${plan.messages.length}`,
		`Effective tools: ${plan.effectiveToolIds.length}`,
		`Execution fingerprint: ${plan.executionFingerprint}`,
		`Conversation fingerprint: ${plan.conversationFingerprint}`,
	];
	return lines.join("\n");
}

function renderFullPrompt(prepared: ForgeSubagentPreparedRun, task: string): string {
	return [
		renderApprovalSummary(prepared, task),
		"",
		"--- SYSTEM PROMPT ---",
		prepared.plan.systemPrompt,
		"",
		"--- MESSAGES ---",
		...prepared.plan.messages.map((message, index) => `[${index}] ${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`),
	].join("\n");
}

// Pi's select/editor UI is a single slot: a second concurrent dialog clears
// the first component and leaves its promise permanently unresolved. Parallel
// tool calls must therefore serialize the interactive approval flow through
// this gate. Execution after each approval is not gated, so approved runs
// still overlap; unattended invocation never enters the gate.
let approvalDialogGate: Promise<void> = Promise.resolve();

function withApprovalDialog<T>(run: () => Promise<T>): Promise<T> {
	const next = approvalDialogGate.then(run);
	approvalDialogGate = next.then(() => undefined, () => undefined);
	return next;
}

export function requestForgeSubagentApproval(
	prepared: ForgeSubagentPreparedRun,
	task: string,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<ForgeSubagentApprovalResult> {
	return withApprovalDialog(async () => {
		let viewedFullPrompt = false;
		while (!signal?.aborted) {
			const choice = await ctx.ui.select(renderApprovalSummary(prepared, task), [APPROVE, VIEW_FULL_PROMPT, REJECT], { signal });
			if (choice === VIEW_FULL_PROMPT) {
				viewedFullPrompt = true;
				await ctx.ui.editor("Subagent approval details (view only; edits are ignored)", renderFullPrompt(prepared, task));
				continue;
			}
			return { approved: choice === APPROVE, viewedFullPrompt };
		}
		return { approved: false, viewedFullPrompt };
	});
}

export function registerForgeSubagentTool(
	pi: ExtensionAPI,
	runtime: ForgeSubagentRuntime,
	options: ForgeSubagentToolRegistrationOptions,
): (ctx: ExtensionContext) => Promise<void> {
	let lastSummary: string | undefined;

	function register(embedded?: string) {
		pi.registerTool({
			name: "forge_subagent",
			label: "Forge Subagent",
			description: forgeSubagentToolDescription(embedded),
			parameters: ForgeSubagentParameters,
			executionMode: "parallel",
			async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ForgeSubagentToolDetails>> {
				const settings = loadForgeSubagentSettings(ctx);
				const approvalRequired = !settings.allowAgentInvocationWithoutApproval;
				const configDiagnostics = settings.warnings.map((message): SubagentDiagnostic => ({ level: "warning", code: "host.config", message }));
				const baseDetails: ForgeSubagentToolDetails = {
					status: "preparing",
					profileId: params.profileId,
					task: params.task,
					approval: { required: approvalRequired, approved: false, viewedFullPrompt: false, source: approvalRequired ? "none" : "trusted-project-config" },
					diagnostics: configDiagnostics,
					progress: [],
				};

				const session = options.sessionProvider();
				if (!session) {
					return { content: toolContent("pi-forge-subagents: no Forge host session (start a session first)."), details: { ...baseDetails, status: "failed" } };
				}
				const policy = resolveSubagentProfilePolicy(settings, params.profileId, approvalRequired ? params.backend : undefined);
				if (!policy.enabled) {
					return {
						content: toolContent(`Pi Forge agent profile "${params.profileId}" is not enabled for subagent delegation.`),
						details: { ...baseDetails, status: "failed" },
					};
				}
				if (!approvalRequired && params.backend && params.backend !== policy.backend.id) {
					return {
						content: toolContent(`Subagent invocation was not run: unattended invocation is pinned to the configured backend "${policy.backend.id}". To use "${params.backend}", run interactively or change the trusted subagent configuration.`),
						details: {
							...baseDetails,
							status: "failed",
							approval: { required: false, approved: false, viewedFullPrompt: false, source: "trusted-project-config" },
						},
					};
				}
				if (params.backend && !runtime.backendIds().includes(params.backend)) {
					return {
						content: toolContent(`Unknown backend: ${params.backend}. Registered backends: ${runtime.backendIds().join(", ") || "none"}.`),
						details: { ...baseDetails, status: "failed" },
					};
				}
				if (approvalRequired && !ctx.hasUI) {
					return {
						content: toolContent("Subagent invocation was not run: interactive human approval is unavailable."),
						details: { ...baseDetails, status: "cancelled" },
					};
				}

				onUpdate?.({ content: toolContent("Preparing the exact subagent prompt; provider transport is still closed."), details: baseDetails });
				let prepared: ForgeSubagentPreparedRun | undefined;
				try {
					const preparation = await runtime.prepare(params.profileId, params.task, ctx, {
						backendId: policy.backend.id,
						timeoutMs: policy.timeout.milliseconds,
					});
					if (!preparation.ok) {
						const diagnostics = [...configDiagnostics, ...preparation.diagnostics];
						return {
							content: toolContent(`Subagent preparation failed:\n${renderDiagnostics(diagnostics)}`),
							details: { ...baseDetails, status: "failed", diagnostics },
						};
					}
					prepared = preparation.prepared;
					const preparedDetails: ForgeSubagentToolDetails = {
						...baseDetails,
						status: approvalRequired ? "awaiting-approval" : "prepared",
						diagnostics: [...configDiagnostics, ...prepared.diagnostics],
					};
					onUpdate?.({
						content: toolContent(approvalRequired ? "The exact plan is ready and awaiting human approval." : "The exact plan is ready; approval bypassed by trusted-project configuration."),
						details: preparedDetails,
					});

					const approval = approvalRequired
						? await requestForgeSubagentApproval(prepared, params.task, ctx, signal)
						: { approved: true, viewedFullPrompt: false };
					if (!approval.approved) {
						await runtime.discard(prepared);
						prepared = undefined;
						return {
							content: toolContent("Subagent invocation was rejected by the human before provider transport."),
							details: { ...preparedDetails, status: "cancelled", approval: { required: true, approved: false, viewedFullPrompt: approval.viewedFullPrompt, source: "none" } },
						};
					}

					const approvedAt = new Date().toISOString();
					const progress: SubagentBackendExecutionUpdate[] = [];
					const running: ForgeSubagentToolDetails = {
						...preparedDetails,
						status: "running",
						approval: {
							required: approvalRequired,
							approved: true,
							viewedFullPrompt: approval.viewedFullPrompt,
							source: approvalRequired ? "human" : "trusted-project-config",
							executionFingerprint: prepared.plan.executionFingerprint,
							approvedAt,
						},
						progress,
					};
					const response = await runtime.execute(prepared, ctx, signal, (update) => {
						progress.push(structuredClone(update));
						if (progress.length > MAX_PROGRESS_ITEMS) progress.splice(0, progress.length - MAX_PROGRESS_ITEMS);
						onUpdate?.({ content: toolContent(update.message), details: { ...running, progress: [...progress] } });
					});
					prepared = undefined;
					const finalDetails: ForgeSubagentToolDetails = {
						...running,
						status: response.status,
						progress: [...progress],
						response,
					};
					return { content: toolContent(response.status === "failed" ? `Subagent failed: ${JSON.stringify(response.error ?? {})}` : response.output?.text ?? "(no output)"), details: finalDetails };
				} catch (error) {
					if (prepared) await runtime.discard(prepared).catch(() => undefined);
					if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
						return { content: toolContent("Subagent invocation was cancelled."), details: { ...baseDetails, status: "cancelled" } };
					}
					const message = error instanceof Error ? error.message : String(error);
					return { content: toolContent(`Subagent invocation failed: ${message}`), details: { ...baseDetails, status: "failed" } };
				}
			},
		});
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		let summary: string | undefined;
		let failed = false;
		try {
			summary = await options.summarize?.(ctx);
		} catch {
			failed = true;
			summary = undefined;
		}
		// Keep the last good embedded summary when a transient catalog failure occurs.
		if (failed && lastSummary !== undefined) return;
		if (summary === lastSummary) return;
		lastSummary = summary;
		register(summary);
	}

	register(undefined);
	return refresh;
}

function forgeSubagentToolDescription(embedded?: string): string {
	const lines = [
		"Delegate a focused task to a Pi Forge agent profile explicitly enabled in subagents.json.",
		"Multiple forge_subagent calls in one turn run concurrently; interactive approvals are serialized one at a time.",
		embedded
			? "The enabled profiles are summarized below; run forge_subagent_profiles for full descriptions, diagnostics, and approval mode."
			: "Use forge_subagent_profiles first when the user has not already specified a profile ID.",
		"Runs require human approval after exact preparation unless the trusted project explicitly enables unattended agent invocation.",
		"The child receives only approved read tools, but runs with the invoking user's OS permissions; read-only is not a sandbox.",
		"The optional backend parameter selects the execution backend for interactively approved runs; unattended invocation always uses the configured default backend.",
		"Use the final report as evidence and do not repeatedly request the same rejected delegation.",
	].join(" ");
	return embedded ? `${lines}\n\n${embedded}` : lines;
}
