import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ForgeHostSession } from "../host/session.ts";
import { backgroundTasksFor } from "../runtime/background-tasks.ts";
import type { ForgeSubagentRuntime } from "../runtime/subagent-runtime.ts";
import { mapForgeSubagentResponseUsage } from "./forge-subagent-usage.ts";

/** Management never starts inference or injects follow-up chat messages. */
export function registerForgeSubagentTaskTool(
	pi: ExtensionAPI,
	runtime: ForgeSubagentRuntime,
	sessionProvider: () => ForgeHostSession | undefined,
): void {
	pi.registerTool({
		name: "forge_subagent_task",
		label: "Forge Subagent Task",
		description: "Inspect same-parent background tasks (status, optional id), collect a finished result and its usage once (result, run id), cancel a task (cancel, run id), or release retained in-process context (release, continuation id). Result collection requires the launch branch or its descendant. No automatic follow-ups; handles expire on parent session shutdown/reload.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("result"), Type.Literal("cancel"), Type.Literal("release")]),
			id: Type.Optional(Type.String({ minLength: 1, description: "Run id for status/result/cancel, continuation id for release." })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				if (!sessionProvider()) throw new Error("No Forge host session.");
				if (params.action !== "status" && !params.id) throw new Error(`${params.action} requires an id.`);
				const manager = backgroundTasksFor(runtime);
				if (params.action === "release") {
					if (!runtime.releaseContinuation) throw new Error("Continuation release requires the updated runtime adapter.");
					await runtime.releaseContinuation(params.id!, ctx);
					return { content: [{ type: "text", text: `Released retained child ${params.id}.` }], details: { action: "release", id: params.id } };
				}
				if (params.action === "cancel") {
					const task = await manager.cancel(ctx, params.id!);
					return { content: [{ type: "text", text: `${task.id}: ${task.status}. Use result to collect any partial output/usage.` }], details: { action: "cancel", task } };
				}
				if (params.action === "status") {
					const tasks = manager.status(ctx, params.id);
					return { content: [{ type: "text", text: tasks.map((task) => `${task.id}: ${task.status} (${task.profileId})${task.collected ? " [collected]" : ""}`).join("\n") || "No background tasks in this parent session." }], details: { action: "status", tasks } };
				}
				const collected = manager.result(ctx, params.id!);
				const mapped = collected.creditUsage ? mapForgeSubagentResponseUsage(collected.response) : {};
				const response = collected.response;
				const text = response
					? `${response.output?.text ?? `Subagent ${response.status}.`}${response.status === "failed" ? `\n${JSON.stringify(response.error)}` : ""}${response.continuationId ? `\nRetained child: ${response.continuationId}` : ""}`
					: `${collected.task.id}: ${collected.task.status}${collected.task.error ? `\n${collected.task.error}` : ". Result not yet available."}`;
				return {
					content: [{ type: "text", text }],
					details: {
						action: "result", task: collected.task, response,
						usageCredited: collected.creditUsage,
						...(mapped.nested ? { forgeNestedUsage: mapped.nested } : {}),
					},
					...(mapped.native ? { usage: mapped.native } : {}),
				};
			} catch (error) {
				return { content: [{ type: "text", text: `Subagent task operation failed: ${error instanceof Error ? error.message : String(error)}` }], details: { action: params.action, status: "failed" } };
			}
		},
	});
}
