import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isAllowedWorkingDirectory, loadForgeSubagentSettings, resolveSubagentProfilePolicy } from "../config/subagents.ts";
import type { AgentResponse } from "../contract/index.ts";
import { snapshotSubagentExecution, type SubagentExecutionDisplay } from "../ui/execution-display.ts";
import type { ForgeSubagentContinuationSummary, ForgeSubagentPreparedRun, ForgeSubagentRunHandle, ForgeSubagentRuntime } from "./subagent-runtime.ts";

export interface BackgroundTaskStatus {
	id: string;
	profileId: string;
	cwd?: string;
	status: "starting" | "running" | AgentResponse["status"];
	collected: boolean;
	execution?: SubagentExecutionDisplay;
	/** Short request-task title; public views omit it outside the known launch branch/descendants. */
	title?: string;
	/** Present only for a terminal task whose retained context is still confirmed alive. */
	continuationId?: string;
	error?: string;
}
export type ForgeContinuationSummary = ForgeSubagentContinuationSummary;
export interface BackgroundReleaseResult {
	/** The retained-context id that was released. */
	continuationId: string;
	/** Set when the caller addressed the release through a background task id. */
	taskId?: string;
}
interface Task extends BackgroundTaskStatus {
	sessionId: string;
	parentCwd: string;
	leafId: string | null;
	handle?: ForgeSubagentRunHandle;
	response?: AgentResponse;
	notifyOnComplete: boolean;
	notificationDone: boolean;
	unattended: boolean;
	requiresModelOverridePermission: boolean;
}
export interface BackgroundTaskResult {
	task: BackgroundTaskStatus;
	response?: AgentResponse;
	/** Only the first model-tool collection may carry a usage receipt. */
	creditUsage: boolean;
}

/** Session-local foreground/background coordination, not durable storage. */
export class ForgeBackgroundTasks {
	private readonly tasks = new Map<string, Task>();
	private epoch = 0;
	private readonly runtime: ForgeSubagentRuntime;
	private readonly limit: number;
	private readonly pendingNotifications = new Set<string>();
	private notificationTimer: ReturnType<typeof setTimeout> | undefined;
	private notificationDelivery: { pi: Pick<ExtensionAPI, "sendMessage">; context: () => ExtensionContext | undefined } | undefined;
	constructor(runtime: ForgeSubagentRuntime, limit = 32) { this.runtime = runtime; this.limit = limit; }

	/** The extension owns delivery and supplies the live parent context, never a launch-time snapshot. */
	configureNotifications(pi: Pick<ExtensionAPI, "sendMessage">, context: () => ExtensionContext | undefined): () => void {
		const delivery = { pi, context };
		this.clearNotifications();
		this.notificationDelivery = delivery;
		return () => {
			if (this.notificationDelivery !== delivery) return;
			this.notificationDelivery = undefined;
			this.clearNotifications();
		};
	}

	async launch(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, options: {
		notifyOnComplete?: boolean;
		unattended?: boolean;
		requiresModelOverridePermission?: boolean;
	} = {}): Promise<BackgroundTaskStatus> {
		if (!this.runtime.start) throw new Error("Background execution requires the updated subagent runtime adapter.");
		for (const [id, task] of this.tasks) {
			if (this.tasks.size < this.limit) break;
			if (task.collected && task.status !== "starting" && task.status !== "running") this.tasks.delete(id);
		}
		if (this.tasks.size >= this.limit) throw new Error("Background task limit reached; collect completed results before starting more.");
		const id = prepared.plan.runId;
		if (this.tasks.has(id)) throw new Error("This prepared run was already launched.");
		const epoch = this.epoch;
		const title = shortTaskTitle(prepared.request?.input?.text);
		const task: Task = {
			id, profileId: prepared.plan.profile.profileId, cwd: prepared.cwd,
			execution: snapshotSubagentExecution(prepared, "background"),
			...(title ? { title } : {}),
			status: "starting", collected: false, sessionId: ctx.sessionManager.getSessionId(),
			parentCwd: ctx.cwd, leafId: ctx.sessionManager.getLeafId?.() ?? null,
			// Both gates apply at launch AND delivery. Turning the master on later cannot revive an opted-out run.
			notifyOnComplete: Boolean(this.notificationDelivery) && options.notifyOnComplete !== false && loadForgeSubagentSettings(ctx).notifyOnComplete === true,
			notificationDone: false,
			unattended: options.unattended ?? false,
			requiresModelOverridePermission: options.requiresModelOverridePermission ?? false,
		};
		// Reserve before awaiting start, so parallel launches respect the bound.
		this.tasks.set(id, task);
		try {
			// Deliberately no parent-turn signal: parent-session disposal owns cancellation.
			const handle = await this.runtime.start(prepared, ctx);
			if (epoch !== this.epoch || this.tasks.get(id) !== task) {
				await handle.cancel("Parent session changed during background start.");
				throw new Error("Parent session changed during background start.");
			}
			task.handle = handle;
			task.status = "running";
			void handle.result.then((response) => {
				try { this.runtime.takeReport?.(response.runId); } catch { /* Optional report cleanup must not discard a terminal response. */ }
				if (epoch !== this.epoch || this.tasks.get(id) !== task) return;
				task.response = response;
				task.status = response.status;
				this.enqueueNotification(task);
			}, (error: unknown) => {
				if (epoch !== this.epoch || this.tasks.get(id) !== task) return;
				task.status = "failed";
				task.error = error instanceof Error ? error.message : String(error);
				this.enqueueNotification(task);
			});
			return this.view(task, ctx);
		} catch (error) {
			if (this.tasks.get(id) === task) this.tasks.delete(id);
			throw error;
		}
	}

	status(ctx: ExtensionContext, id?: string): BackgroundTaskStatus[] {
		if (id) return [this.view(this.owned(ctx, id), ctx)];
		return [...this.tasks.values()].filter((task) => this.sameOwner(task, ctx)).map((task) => this.view(task, ctx));
	}

	/** Lists retained contexts of this parent session; does not claim results or usage. */
	contexts(ctx: ExtensionContext): ForgeContinuationSummary[] {
		const list = this.runtime.listContinuations;
		if (!list) throw new Error("Listing retained contexts requires the updated runtime adapter.");
		return list.call(this.runtime, ctx).map((entry) => ({
			id: entry.id, profileId: entry.profileId, backendId: entry.backendId, cwd: entry.cwd,
			model: { provider: entry.model.provider, id: entry.model.id }, thinkingLevel: entry.thinkingLevel,
		}));
	}

	/**
	 * Release a retained context by continuation id, or by the id of a finished
	 * same-parent background task. Cleanup is deliberately independent of the
	 * result branch gate and never marks the task collected, drops its response
	 * or touches usage accounting.
	 */
	async release(ctx: ExtensionContext, id: string): Promise<BackgroundReleaseResult> {
		if (!this.runtime.releaseContinuation) throw new Error("Continuation release requires the updated runtime adapter.");
		const task = this.tasks.get(id);
		if (!task || !this.sameOwner(task, ctx)) {
			await this.runtime.releaseContinuation(id, ctx);
			return { continuationId: id };
		}
		if (task.status === "starting" || task.status === "running") {
			throw new Error(`Task ${id} is still ${task.status}; cancel it (and wait for it to finish) before releasing its context.`);
		}
		const continuationId = task.response?.continuationId;
		if (!continuationId) throw new Error(`Task ${id} has no retained context to release.`);
		if (!this.alive(continuationId, ctx)) throw new Error(`Retained context of task ${id} was already released or expired.`);
		await this.runtime.releaseContinuation(continuationId, ctx);
		return { continuationId, taskId: id };
	}

	result(ctx: ExtensionContext, id: string, claimUsage = true): BackgroundTaskResult {
		const task = this.owned(ctx, id);
		// Reading/crediting a result on an unrelated fork would route child output
		// into the wrong conversation. Status/cancel remain session-wide controls.
		if (task.leafId !== null && ctx.sessionManager.getLeafId?.() !== task.leafId &&
			!ctx.sessionManager.getBranch().some((entry) => entry.id === task.leafId)) {
			throw new Error("Return to the launch branch (or a descendant) to collect this result.");
		}
		const ready = task.status !== "starting" && task.status !== "running";
		const creditUsage = ready && Boolean(task.response) && claimUsage && !task.collected;
		// Synchronous claim: concurrent result tools cannot both emit usage.
		if (ready && claimUsage) {
			task.collected = true;
			this.pendingNotifications.delete(task.id);
		}
		return { task: this.view(task, ctx), ...(task.response ? { response: structuredClone(task.response) } : {}), creditUsage };
	}

	async cancel(ctx: ExtensionContext, id: string): Promise<BackgroundTaskStatus> {
		const task = this.owned(ctx, id);
		if (task.status === "starting") throw new Error("Task is still starting; retry cancellation once the launch returns.");
		// Suppress before awaiting: a terminal callback during cancellation must not wake the parent.
		task.notifyOnComplete = false;
		this.pendingNotifications.delete(task.id);
		await task.handle?.cancel("Cancelled by parent request.");
		return this.view(task, ctx);
	}

	/** Invalidate results immediately; runtime.dispose() drains actual child work. */
	clear(): void { this.epoch++; this.clearNotifications(); this.tasks.clear(); }

	private clearNotifications(): void {
		if (this.notificationTimer !== undefined) clearTimeout(this.notificationTimer);
		this.notificationTimer = undefined;
		this.pendingNotifications.clear();
	}

	private enqueueNotification(task: Task): void {
		if (!this.notificationDelivery || !task.notifyOnComplete || task.notificationDone || task.collected || task.status === "cancelled") return;
		this.pendingNotifications.add(task.id);
		if (this.notificationTimer !== undefined) return;
		// One ephemeral tick coalesces simultaneous terminal callbacks. No polling or durable worker.
		this.notificationTimer = setTimeout(() => {
			this.notificationTimer = undefined;
			this.deliverNotifications();
		}, 0);
	}

	private deliverNotifications(): void {
		const delivery = this.notificationDelivery;
		const ids = [...this.pendingNotifications];
		this.pendingNotifications.clear();
		if (!delivery) return;
		try {
			const ctx = delivery.context();
			if (!ctx) return;
			const settings = loadForgeSubagentSettings(ctx);
			const eligible: Task[] = [];
			for (const id of ids) {
				const task = this.tasks.get(id);
				if (!task || task.notificationDone) continue;
				// Invalid context is safely suppressed, not replayed when trust/branch later changes.
				task.notificationDone = true;
				if (!task.notifyOnComplete || task.collected || task.status === "starting" || task.status === "running" || task.status === "cancelled") continue;
				if (!this.sameOwner(task, ctx) || !ctx.isProjectTrusted() || settings.notifyOnComplete !== true) continue;
				if (task.leafId !== null && ctx.sessionManager.getLeafId?.() !== task.leafId &&
					!ctx.sessionManager.getBranch().some((entry) => entry.id === task.leafId)) continue;
				const policy = resolveSubagentProfilePolicy(settings, task.profileId);
				if (!policy.enabled) continue;
				if (task.unattended && (!settings.allowAgentInvocationWithoutApproval ||
					(task.requiresModelOverridePermission && !policy.allowAgentModelOverrides) ||
					(task.cwd && !isAllowedWorkingDirectory(settings, task.cwd, task.parentCwd)))) continue;
				eligible.push(task);
			}
			if (eligible.length === 0) return;
			// Only safe, short handles/statuses; NEVER prompt, output, profile, cwd, error or usage.
			const rows = eligible.filter((task) => /^[a-zA-Z0-9_-]{1,24}$/.test(task.id))
				.map((task) => `${task.id}: ${task.status}`);
			if (rows.length === 0) return;
			delivery.pi.sendMessage({
				customType: "forge-subagent-completion",
				content: `Background subagent tasks finished: ${rows.join("; ")}. Call forge_subagent_task action result with each task id to collect the result.`,
				// Display metadata only; SDK convertToLlm forwards content, not details.
				details: { tasks: rows.map((row) => {
					const [id, status] = row.split(": ");
					return { id, status };
				}) },
				display: true,
			}, ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" });
		} catch {
			// Fail closed: invalidated contexts / unavailable SDK delivery must not retry and revive wakes.
			// Task status/result remain readable through the existing controls.
		}
	}

	private alive(continuationId: string, ctx: ExtensionContext): boolean {
		// Legacy adapters cannot confirm liveness; production runtimes can.
		if (!this.runtime.continuationInfo) return true;
		try { return this.runtime.continuationInfo(continuationId, ctx) !== undefined; } catch { return false; }
	}
	private view(task: Task, ctx: ExtensionContext): BackgroundTaskStatus {
		const status = publicStatus(task);
		// Task text is branch-sensitive even when selected model metadata is same-owner visible.
		// Unknown legacy/null launch leaves fail closed for titles (the existing result gate is unchanged).
		if (task.title && this.sameOwner(task, ctx) && task.leafId !== null &&
			(ctx.sessionManager.getLeafId?.() === task.leafId || ctx.sessionManager.getBranch().some((entry) => entry.id === task.leafId))) {
			status.title = task.title;
		}
		const continuationId = task.response?.continuationId;
		if (continuationId && this.alive(continuationId, ctx)) status.continuationId = continuationId;
		return status;
	}
	private sameOwner(task: Task, ctx: ExtensionContext): boolean {
		return task.sessionId === ctx.sessionManager.getSessionId() && task.parentCwd === ctx.cwd;
	}
	private owned(ctx: ExtensionContext, id: string): Task {
		const task = this.tasks.get(id);
		if (!task || !this.sameOwner(task, ctx)) throw new Error("Unknown background task in this parent session.");
		return task;
	}
}

function shortTaskTitle(text: unknown): string | undefined {
	if (typeof text !== "string") return undefined;
	const chars = Array.from(text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim());
	if (!chars.length) return undefined;
	return chars.length <= 100 ? chars.join("") : `${chars.slice(0, 97).join("")}...`;
}

function publicStatus(task: Task): BackgroundTaskStatus {
	return { id: task.id, profileId: task.profileId, ...(task.cwd ? { cwd: task.cwd } : {}), status: task.status, collected: task.collected, ...(task.execution ? { execution: structuredClone(task.execution) } : {}), ...(task.error ? { error: task.error } : {}) };
}

const managers = new WeakMap<ForgeSubagentRuntime, ForgeBackgroundTasks>();
export function backgroundTasksFor(runtime: ForgeSubagentRuntime): ForgeBackgroundTasks {
	let manager = managers.get(runtime);
	if (!manager) { manager = new ForgeBackgroundTasks(runtime); managers.set(runtime, manager); }
	return manager;
}
