import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentResponse } from "../contract/index.ts";
import type { ForgeSubagentPreparedRun, ForgeSubagentRunHandle, ForgeSubagentRuntime } from "./subagent-runtime.ts";

export interface BackgroundTaskStatus {
	id: string;
	profileId: string;
	cwd?: string;
	status: "starting" | "running" | AgentResponse["status"];
	collected: boolean;
	error?: string;
}
interface Task extends BackgroundTaskStatus {
	sessionId: string;
	parentCwd: string;
	leafId: string | null;
	handle?: ForgeSubagentRunHandle;
	response?: AgentResponse;
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
	constructor(runtime: ForgeSubagentRuntime, limit = 32) { this.runtime = runtime; this.limit = limit; }

	async launch(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext): Promise<BackgroundTaskStatus> {
		if (!this.runtime.start) throw new Error("Background execution requires the updated subagent runtime adapter.");
		for (const [id, task] of this.tasks) {
			if (this.tasks.size < this.limit) break;
			if (task.collected && task.status !== "starting" && task.status !== "running") this.tasks.delete(id);
		}
		if (this.tasks.size >= this.limit) throw new Error("Background task limit reached; collect completed results before starting more.");
		const id = prepared.plan.runId;
		if (this.tasks.has(id)) throw new Error("This prepared run was already launched.");
		const epoch = this.epoch;
		const task: Task = {
			id, profileId: prepared.plan.profile.profileId, cwd: prepared.cwd,
			status: "starting", collected: false, sessionId: ctx.sessionManager.getSessionId(),
			parentCwd: ctx.cwd, leafId: ctx.sessionManager.getLeafId?.() ?? null,
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
			}, (error: unknown) => {
				if (epoch !== this.epoch || this.tasks.get(id) !== task) return;
				task.status = "failed";
				task.error = error instanceof Error ? error.message : String(error);
			});
			return publicStatus(task);
		} catch (error) {
			if (this.tasks.get(id) === task) this.tasks.delete(id);
			throw error;
		}
	}

	status(ctx: ExtensionContext, id?: string): BackgroundTaskStatus[] {
		if (id) return [publicStatus(this.owned(ctx, id))];
		return [...this.tasks.values()].filter((task) => this.sameOwner(task, ctx)).map(publicStatus);
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
		if (ready && claimUsage) task.collected = true;
		return { task: publicStatus(task), ...(task.response ? { response: structuredClone(task.response) } : {}), creditUsage };
	}

	async cancel(ctx: ExtensionContext, id: string): Promise<BackgroundTaskStatus> {
		const task = this.owned(ctx, id);
		if (task.status === "starting") throw new Error("Task is still starting; retry cancellation once the launch returns.");
		await task.handle?.cancel("Cancelled by parent request.");
		return publicStatus(task);
	}

	/** Invalidate results immediately; runtime.dispose() drains actual child work. */
	clear(): void { this.epoch++; this.tasks.clear(); }

	private sameOwner(task: Task, ctx: ExtensionContext): boolean {
		return task.sessionId === ctx.sessionManager.getSessionId() && task.parentCwd === ctx.cwd;
	}
	private owned(ctx: ExtensionContext, id: string): Task {
		const task = this.tasks.get(id);
		if (!task || !this.sameOwner(task, ctx)) throw new Error("Unknown background task in this parent session.");
		return task;
	}
}

function publicStatus(task: Task): BackgroundTaskStatus {
	return { id: task.id, profileId: task.profileId, ...(task.cwd ? { cwd: task.cwd } : {}), status: task.status, collected: task.collected, ...(task.error ? { error: task.error } : {}) };
}

const managers = new WeakMap<ForgeSubagentRuntime, ForgeBackgroundTasks>();
export function backgroundTasksFor(runtime: ForgeSubagentRuntime): ForgeBackgroundTasks {
	let manager = managers.get(runtime);
	if (!manager) { manager = new ForgeBackgroundTasks(runtime); managers.set(runtime, manager); }
	return manager;
}
