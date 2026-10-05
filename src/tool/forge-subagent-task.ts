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
		description: "Inspect same-parent background tasks (status, optional id), collect a finished result and its usage once (result, run id), cancel a task (cancel, run id), or list retained contexts (contexts: profile/model/thinking/cwd only, no output or usage claim), or release retained in-process context (release, continuation id or finished background task id; running tasks must be cancelled first). Result collection requires the launch branch or its descendant. No automatic follow-ups; handles expire on parent session shutdown/reload.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("status"), Type.Literal("result"), Type.Literal("cancel"), Type.Literal("release"), Type.Literal("contexts")]),
			id: Type.Optional(Type.String({ minLength: 1, description: "Run id for status/result/cancel, continuation or finished task id for release; ignored by contexts." })),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				if (!sessionProvider()) throw new Error("No Forge host session.");
				if (params.action !== "status" && params.action !== "contexts" && !params.id) throw new Error(`${params.action} requires an id.`);
				const manager = backgroundTasksFor(runtime);
				if (params.action === "release") {
					const released = await manager.release(ctx, params.id!);
					return { content: [{ type: "text", text: `Released retained child ${released.continuationId}${released.taskId ? ` (task ${released.taskId})` : ""}.` }], details: { action: "release", id: params.id, continuationId: released.continuationId, ...(released.taskId ? { taskId: released.taskId } : {}) } };
				}
				if (params.action === "contexts") {
					const contexts = manager.contexts(ctx);
					return { content: [{ type: "text", text: contexts.map((c) => `${c.id}: ${c.profileId} ${c.model.provider}/${c.model.id} thinking=${c.thinkingLevel} cwd=${c.cwd}`).join("\n") || "No retained contexts in this parent session." }], details: { action: "contexts", contexts } };
				}
				if (params.action === "cancel") {
					const task = await manager.cancel(ctx, params.id!);
					return { content: [{ type: "text", text: `${task.id}: ${task.status}. Use result to collect any partial output/usage.` }], details: { action: "cancel", task } };
				}
				if (params.action === "status") {
					const tasks = manager.status(ctx, params.id);
					return { content: [{ type: "text", text: tasks.map((task) => `${task.id}: ${task.status} (${task.profileId})${task.collected ? " [collected]" : ""}${task.continuationId ? ` [retained: ${task.continuationId}]` : ""}`).join("\n") || "No background tasks in this parent session." }], details: { action: "status", tasks } };
				}
				const collected = manager.result(ctx, params.id!);
				const mapped = collected.creditUsage ? mapForgeSubagentResponseUsage(collected.response) : {};
				const response = collected.response;
				const text = response
					? `${response.output?.text ?? `Subagent ${response.status}.`}${response.status === "failed" ? `\n${JSON.stringify(response.error)}` : ""}${collected.task.continuationId ? `\nRetained child: ${collected.task.continuationId}` : response.continuationId ? "\nRetained context has been released or expired." : ""}`
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
