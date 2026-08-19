import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadForgeSubagentSettings } from "../config/subagents.ts";
import type { ForgeHostSession } from "../host/session.ts";
import type { ForgeSubagentRuntime } from "../runtime/subagent-runtime.ts";
import { requestForgeSubagentApproval } from "../tool/forge-subagent.ts";

export function registerForgeAgentCommand(
	pi: ExtensionAPI,
	runtime: ForgeSubagentRuntime,
	sessionProvider: () => ForgeHostSession | undefined,
): void {
	pi.registerCommand("forge-agent", {
		description: "Plan or run a foreground human-approved read-only agent profile",
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			if (!trimmed.includes(" ")) {
				return ["backends", "plan", "run"].filter((cmd) => cmd.startsWith(trimmed)).map((cmd) => ({ value: cmd, label: cmd }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [command = "help", ...rest] = trimmed ? trimmed.split(/\s+/) : ["help"];
			if (command === "help" || command === "backends") {
				if (command === "backends") await showBackends(runtime, ctx);
				else await showHelp(ctx);
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

			const parsed = parsePlanRunArgs(command, rest);
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
		},
	});
}

type ParsedPlanRun =
	| { ok: true; profile: string; task: string; backend?: string }
	| { ok: false; error: string };

function parsePlanRunArgs(command: string, rest: string[]): ParsedPlanRun {
	const positional: string[] = [];
	let backend: string | undefined;
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index]!;
		if (token === "--backend") {
			const value = rest[index + 1];
			if (!value || value.startsWith("--")) return { ok: false, error: "--backend requires a backend id value." };
			backend = value;
			index++;
			continue;
		}
		if (token.startsWith("--backend=")) {
			const value = token.slice("--backend=".length);
			if (!value) return { ok: false, error: "--backend requires a backend id value." };
			backend = value;
			continue;
		}
		if (token.startsWith("--")) return { ok: false, error: `Unknown option: ${token}` };
		positional.push(token);
	}
	const [profile, ...taskTokens] = positional;
	if (!profile) return { ok: false, error: `Usage: /forge-agent ${command} <profile> [--backend <id>] <task>` };
	if (taskTokens.length === 0) return { ok: false, error: `Usage: /forge-agent ${command} <profile> [--backend <id>] <task>` };
	return { ok: true, profile, task: taskTokens.join(" "), ...(backend ? { backend } : {}) };
}

async function showBackends(runtime: ForgeSubagentRuntime, ctx: ExtensionCommandContext): Promise<void> {
	const settings = loadForgeSubagentSettings(ctx);
	const descriptors = runtime.descriptors(ctx);
	const lines = descriptors.map((descriptor) => [
		`${descriptor.id} @ ${descriptor.version}`,
		`  default boundary: shared-user subprocess with read-only model tools`,
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
		"Foreground read-only subprocess agent commands:",
		"",
		"  /forge-agent backends",
		"  /forge-agent plan <profile> [--backend <id>] <task>",
		"  /forge-agent run <profile> [--backend <id>] <task>",
		"",
		"plan prepares and validates the exact request without provider transport.",
		"run prepares the exact prompt, asks for human approval, then executes one foreground text task.",
	].join("\n"));
}

async function showText(ctx: ExtensionCommandContext, title: string, text: string): Promise<void> {
	if (ctx.hasUI) {
		await ctx.ui.editor(title, text);
		return;
	}
	console.log(text);
}
