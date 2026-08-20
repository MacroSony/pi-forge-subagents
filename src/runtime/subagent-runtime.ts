import { randomUUID } from "node:crypto";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
	createExecutionRuntime,
	error,
	type ExecutionBackend,
	type ExecutionIntent,
	type ExecutionRuntime,
	type PreparedRun,
	type PromptRuntime,
	type RunResult,
} from "@zihanw/pi-subagent-runtime";
import {
	PI_READ_ONLY_TOOL_CATALOG,
	PiSubprocessBackend,
	type PiSubprocessBackendOptions,
	type PiSubprocessRunReport,
} from "@zihanw/pi-subagent-runtime/backends/subprocess";
import {
	PiRpcBackend,
	type PiRpcBackendOptions,
} from "@zihanw/pi-subagent-runtime/backends/rpc";
import {
	SUBAGENT_CONTRACT_VERSION,
	createAgentExecutionPlan,
	hasSubagentErrors,
	negotiateSubagentTools,
	type AgentExecutionPlan,
	type AgentProfileSnapshot,
	type AgentRequest,
	type AgentResponse,
	type BackendPreflightAccepted,
	type SubagentBackendDescriptor,
	type SubagentDiagnostic,
	type SubagentPreparedMessage,
	type SubagentPreparationOutput,
} from "../contract/index.ts";
import type { ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import type { ForgeHostSession } from "../host/session.ts";
import {
	MAX_SUBAGENT_TIMEOUT_MS,
	MIN_SUBAGENT_TIMEOUT_MS,
	isValidSubagentTimeoutMs,
	loadForgeSubagentSettings,
	resolveSubagentProfilePolicy,
} from "../config/subagents.ts";

export interface ForgeSubagentPreparedRun {
	request: AgentRequest;
	preflight: BackendPreflightAccepted;
	plan: AgentExecutionPlan;
	diagnostics: SubagentDiagnostic[];
}

export type ForgeSubagentPreparationResult =
	| { ok: true; prepared: ForgeSubagentPreparedRun }
	| { ok: false; diagnostics: SubagentDiagnostic[] };

/** Host-facing execution update; phases match the runtime's run events. */
export interface SubagentBackendExecutionUpdate {
	phase: "starting" | "message" | "tool-result" | "finishing";
	message: string;
	details?: unknown;
}

export interface ForgeSubagentRuntime {
	backendIds(): string[];
	descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[];
	prepare(profileId: string, task: string, ctx: ExtensionContext, run?: { backendId?: string; timeoutMs?: number }): Promise<ForgeSubagentPreparationResult>;
	discard(prepared: ForgeSubagentPreparedRun): Promise<void>;
	execute(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse>;
	takeReport?(runId: string): PiSubprocessRunReport | undefined;
	dispose(): Promise<void>;
}

interface ReportCapableBackend extends ExecutionBackend {
	takeReport(preparedRunId: string): PiSubprocessRunReport | undefined;
	dispose?(): Promise<void>;
}

export interface ForgeSubagentRuntimeOptions {
	backendId?: string;
	subprocess?: Omit<PiSubprocessBackendOptions, "modelRegistry" | "cwd">;
	rpc?: Omit<PiRpcBackendOptions, "modelRegistry" | "cwd">;
	/** Extra backends registered alongside the built-in subprocess/RPC backends (mainly for tests). */
	extraBackends?: ExecutionBackend[];
	/** When false, do not construct the built-in subprocess/RPC backends (tests inject their own). */
	builtInBackends?: boolean;
	/** Tool catalog used to build the execution intent (defaults to the read-only subprocess catalog). */
	intentToolCatalog?: BackendPreflightAccepted["toolCatalog"];
}

interface RuntimeGeneration {
	runtime: ExecutionRuntime;
	backends: Map<string, ReportCapableBackend>;
	modelRegistry: ModelRegistry;
	cwd: string;
}

interface PreparedRecord {
	generation: RuntimeGeneration;
	handle: PreparedRun;
	backend: ReportCapableBackend;
}

/**
 * Optional-package execution runtime. The host port owns profile/stack
 * resolution and prompt compilation; this runtime owns backend preflight,
 * sealing (conversation/execution fingerprints), approval-safe prepared plans,
 * and execution through @zihanw/pi-subagent-runtime.
 */
export function createForgeSubagentRuntime(
	sessionProvider: () => ForgeHostSession | undefined,
	options: ForgeSubagentRuntimeOptions = {},
): ForgeSubagentRuntime {
	let generation: RuntimeGeneration | undefined;
	// Disposal of replaced generations is serialized through this chain; callers
	// that are about to use a fresh generation await it so teardown of the
	// previous generation cannot race the new one. Errors are caught and surfaced
	// (logged) so a failed disposal never wedges the chain or becomes an unhandled
	// rejection.
	let disposalChain: Promise<void> = Promise.resolve();
	const prepared = new Map<string, PreparedRecord>();
	const reports = new Map<string, { backend: ReportCapableBackend; preparedRunId: string }>();
	const backendIds = ["pi-subprocess-readonly", "pi-rpc-readonly"];

	async function disposeGeneration(target: RuntimeGeneration): Promise<void> {
		await target.runtime.dispose();
		await Promise.all([...target.backends.values()].map((backend) => backend.dispose?.()));
	}

	function surfaceDisposalError(label: string, disposeError: unknown): void {
		// eslint-disable-next-line no-console
		console.error(`[pi-forge-subagents] ${label}: ${disposeError instanceof Error ? disposeError.stack ?? disposeError.message : String(disposeError)}`);
	}

	function scheduleDisposal(target: RuntimeGeneration): void {
		disposalChain = disposalChain
			.then(() => disposeGeneration(target))
			.catch((disposeError: unknown) => surfaceDisposalError("runtime generation disposal failed", disposeError));
	}

	function ensure(ctx: ExtensionContext): RuntimeGeneration {
		if (generation && generation.modelRegistry === ctx.modelRegistry && generation.cwd === ctx.cwd) return generation;
		if (generation) scheduleDisposal(generation);
		const runtime = createExecutionRuntime();
		const backends = new Map<string, ReportCapableBackend>();
		if (options.builtInBackends !== false) {
			const subprocess = new PiSubprocessBackend({
				modelRegistry: ctx.modelRegistry,
				cwd: ctx.cwd,
				...options.subprocess,
			});
			const rpc = new PiRpcBackend({
				modelRegistry: ctx.modelRegistry,
				cwd: ctx.cwd,
				...options.rpc,
			});
			backends.set(subprocess.descriptor.id, subprocess);
			backends.set(rpc.descriptor.id, rpc);
		}
		for (const extra of options.extraBackends ?? []) {
			backends.set(extra.descriptor.id, extra as ReportCapableBackend);
		}
		for (const backend of backends.values()) runtime.registerBackend(backend);
		generation = { runtime, backends, modelRegistry: ctx.modelRegistry, cwd: ctx.cwd };
		return generation;
	}

	function descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[] {
		return ensure(ctx).runtime.listBackends().map(descriptorForHost);
	}

	async function prepare(profileId: string, task: string, ctx: ExtensionContext, run?: { backendId?: string; timeoutMs?: number }): Promise<ForgeSubagentPreparationResult> {
		const diagnostics: SubagentDiagnostic[] = [];
		if (!ctx.isProjectTrusted()) {
			return { ok: false, diagnostics: [error("host.trust", "Project is not trusted; subagent profiles remain disabled.")] };
		}
		const session = sessionProvider();
		if (!session) {
			return { ok: false, diagnostics: [error("host.session", "No pi-forge host session; start a session first.")] };
		}
		const canonicalProfileId = profileId;
		const policy = resolveSubagentProfilePolicy(loadForgeSubagentSettings(ctx), canonicalProfileId);
		if (!policy.enabled) {
			return {
				ok: false,
				diagnostics: [error("host.profile-disabled", `Agent profile "${profileId}" is not enabled for subagent delegation in subagents.json.`)],
			};
		}
		const timeoutMs = run?.timeoutMs ?? policy.timeout.milliseconds;
		if (!isValidSubagentTimeoutMs(timeoutMs)) {
			return {
				ok: false,
				diagnostics: [error("host.timeout", `Subagent timeout must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`)],
			};
		}

		let snapshot: AgentProfileSnapshot;
		try {
			const resolved = await session.resolveProfile(canonicalProfileId);
			snapshot = resolved.snapshot as AgentProfileSnapshot;
		} catch (resolveError) {
			diagnostics.push(error("host.profile-missing", resolveError instanceof Error ? resolveError.message : String(resolveError)));
			return { ok: false, diagnostics };
		}

		const request: AgentRequest = {
			schemaVersion: SUBAGENT_CONTRACT_VERSION,
			requestId: `request:${randomUUID()}`,
			profileId: canonicalProfileId,
			expectedProfileFingerprint: snapshot.profileFingerprint,
			input: { text: task },
			access: {
				level: "read-only",
				workspaces: [{ handle: "project", mode: "read-only" }],
				workingDirectory: { workspaceHandle: "project", path: "." },
				network: "allow",
				executionBoundary: "shared-user",
			},
			limits: { timeoutMs: { value: timeoutMs, enforcement: "best-effort" } },
			resultProjection: { maxChars: 12_000 },
			parent: { sessionId: ctx.sessionManager.getSessionId(), depth: 0, maxDepth: 1 },
			remoteEgressConsent: true,
		};
		const current = ensure(ctx);
		// A replaced generation must finish tearing down before we start preparing
		// against the fresh generation.
		await disposalChain;
		const backendId = run?.backendId ?? options.backendId ?? policy.backend.id;
		const backend = current.backends.get(backendId);
		if (!backend) return { ok: false, diagnostics: [error("host.backend", `Backend is not registered: ${backendId}`)] };
		const intent = executionIntentFor(request, snapshot, options.intentToolCatalog ?? forgeToolCatalog());

		let hostPreparation: SubagentPreparationOutput | undefined;
		let handle: PreparedRun;
		try {
			handle = await current.runtime.prepare({
				backendId,
				intent,
				...(ctx.signal ? { signal: ctx.signal } : {}),
				compile: async (promptRuntime: PromptRuntime, acceptedPreflight: import("@zihanw/pi-subagent-runtime").BackendPreflightAccepted) => {
					const preparedResponse = await session.prepare({
						profile: canonicalProfileId,
						task: { text: task },
						access: {
							level: request.access.level,
							network: request.access.network,
							allowProcess: request.access.allowProcess ?? false,
						},
						backend: {
							model: { provider: promptRuntime.model.provider, id: promptRuntime.model.id },
							thinkingLevel: (acceptedPreflight.thinkingLevel ?? snapshot.profile.thinkingLevel) as string,
							toolCatalog: acceptedPreflight.toolCatalog.map((tool) => ({
								id: tool.id,
								name: tool.name,
								effects: [...tool.effects],
							})),
						},
					});
					hostPreparation = toPreparationOutput(preparedResponse);
					return {
						systemPrompt: preparedResponse.systemPrompt,
						messages: (preparedResponse.messages as SubagentPreparedMessage[]).map(portableMessage),
					};
				},
			});
		} catch (prepareError) {
			const nested = (prepareError as { diagnostics?: unknown }).diagnostics;
			if (Array.isArray(nested)) {
				diagnostics.push(...(nested as SubagentDiagnostic[]));
			} else {
				diagnostics.push(error("host.preparation", prepareError instanceof Error ? prepareError.message : String(prepareError)));
			}
			return { ok: false, diagnostics };
		}

		const sealed = handle.snapshot();
		diagnostics.push(...sealed.preflight.diagnostics);
		if (!hostPreparation) {
			await handle.discard();
			diagnostics.push(error("host.preparation", "Host compilation did not complete."));
			return { ok: false, diagnostics };
		}
		// Host preparation diagnostics are collected exactly once below, inside the
		// plan's own diagnostics (createAgentExecutionPlan spreads
		// preparation.diagnostics; toolNegotiation.diagnostics is intentionally left
		// empty), so they must not be re-pushed here.
		const planned = createAgentExecutionPlan({
			runId: handle.id,
			request,
			snapshot,
			preflight: preflightForHost(sealed.preflight),
			preparation: hostPreparation,
			runtime: sealed.promptRuntime,
			conversationFingerprint: sealed.conversationFingerprint,
			executionFingerprint: sealed.executionFingerprint,
		});
		diagnostics.push(...planned.diagnostics);
		if (!planned.plan || hasSubagentErrors(diagnostics)) {
			await handle.discard();
			return { ok: false, diagnostics };
		}
		prepared.set(handle.id, { generation: current, handle, backend });
		return { ok: true, prepared: { request, preflight: planned.plan.preflight, plan: planned.plan, diagnostics } };
	}

	async function discard(preparedRun: ForgeSubagentPreparedRun): Promise<void> {
		const record = prepared.get(preparedRun.plan.runId);
		if (!record) return;
		prepared.delete(preparedRun.plan.runId);
		await record.handle.discard();
	}

	async function execute(preparedRun: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse> {
		const record = prepared.get(preparedRun.plan.runId);
		if (!record) throw new Error("Subagent prepared run is unknown to this runtime generation.");
		const current = ensure(ctx);
		// Same serialization as prepare: never execute against a fresh generation
		// while a replaced generation is still tearing down.
		await disposalChain;
		if (record.generation !== current) throw new Error("Subagent prepared run belongs to a previous runtime generation.");
		prepared.delete(preparedRun.plan.runId);
		const run = current.runtime.execute(record.handle);
		reports.set(run.id, { backend: record.backend, preparedRunId: record.handle.id });
		if (onUpdate) {
			run.subscribe((event) => {
				onUpdate({
					phase: event.phase,
					message: event.message,
					...(event.details === undefined ? {} : { details: event.details }),
				});
			});
		}
		let cancelOnAbort: (() => void) | undefined;
		if (signal) {
			cancelOnAbort = () => { void run.cancel(cancelReason(signal)); };
			if (signal.aborted) cancelOnAbort();
			else signal.addEventListener("abort", cancelOnAbort, { once: true });
		}
		try {
			const result = await run.result;
			return responseForHost(preparedRun, result);
		} finally {
			if (signal && cancelOnAbort) signal.removeEventListener("abort", cancelOnAbort);
		}
	}

	function takeReport(runId: string): PiSubprocessRunReport | undefined {
		const location = reports.get(runId);
		if (!location) return undefined;
		reports.delete(runId);
		return location.backend.takeReport(location.preparedRunId);
	}

	async function dispose(): Promise<void> {
		prepared.clear();
		reports.clear();
		const target = generation;
		generation = undefined;
		if (target) {
			await disposeGeneration(target).catch((disposeError: unknown) => surfaceDisposalError("runtime disposal failed", disposeError));
		}
		// Drain any replaced generations still finishing teardown.
		await disposalChain;
	}

	return { backendIds: () => [...backendIds], descriptors, prepare, discard, execute, takeReport, dispose };
}

function toPreparationOutput(prepared: ForgePrepareResponse): SubagentPreparationOutput {
	return {
		systemPrompt: prepared.systemPrompt,
		messages: prepared.messages as SubagentPreparedMessage[],
		contextBudget: undefined,
		toolNegotiation: {
			effectiveToolIds: prepared.effectiveToolIds,
			effectiveToolNames: prepared.effectiveToolNames,
			stackSelectedToolNames: prepared.effectiveToolNames,
			unmatchedAllowPatterns: [],
			// Host preparation diagnostics belong at the top level only. Sharing the
			// same array here would double-count every entry when prepare() collects
			// plan diagnostics below.
			diagnostics: [],
		},
		diagnostics: (prepared.diagnostics as SubagentDiagnostic[]),
	};
}

function executionIntentFor(
	request: AgentRequest,
	snapshot: AgentProfileSnapshot,
	toolCatalog: BackendPreflightAccepted["toolCatalog"],
): ExecutionIntent {
	const negotiation = negotiateSubagentTools(
		toolCatalog,
		snapshot.promptStack?.tools,
		request.access,
	);
	return {
		model: structuredClone(snapshot.profile.model),
		thinkingLevel: snapshot.profile.thinkingLevel,
		requestedTools: negotiation.effectiveToolNames,
		access: {
			level: request.access.level,
			executionBoundary: "shared-user",
			workspaces: structuredClone(request.access.workspaces),
			...(request.access.workingDirectory ? { workingDirectory: structuredClone(request.access.workingDirectory) } : {}),
			network: request.access.network,
			...(request.access.allowProcess === undefined ? {} : { allowProcess: request.access.allowProcess }),
		},
		limits: structuredClone(request.limits),
		provenance: {
			profile: snapshot.profileFingerprint,
			profileId: snapshot.profileId,
			...(snapshot.promptStackFingerprint ? { promptStack: snapshot.promptStackFingerprint } : {}),
			...(snapshot.promptStackId ? { promptStackId: snapshot.promptStackId } : {}),
		},
	};
}

function forgeToolCatalog(): BackendPreflightAccepted["toolCatalog"] {
	return PI_READ_ONLY_TOOL_CATALOG.map((tool) => ({
		...structuredClone(tool),
		effects: [...tool.effects],
	})) as BackendPreflightAccepted["toolCatalog"];
}

function preflightForHost(preflight: import("@zihanw/pi-subagent-runtime").BackendPreflightAccepted): BackendPreflightAccepted {
	return {
		status: "accepted",
		preflightId: preflight.preflightId,
		backend: descriptorForHost(preflight.backend),
		model: structuredClone(preflight.model),
		thinkingLevel: (preflight.thinkingLevel ?? "medium") as BackendPreflightAccepted["thinkingLevel"],
		toolCatalog: structuredClone(preflight.toolCatalog) as BackendPreflightAccepted["toolCatalog"],
		access: structuredClone(preflight.access) as BackendPreflightAccepted["access"],
		limits: structuredClone(preflight.limits) as BackendPreflightAccepted["limits"],
		...(preflight.promptRuntime ? { promptRuntime: preflight.promptRuntime } : {}),
		diagnostics: [...preflight.diagnostics].map((diagnostic) => ({ ...diagnostic })),
	};
}

function descriptorForHost(descriptor: import("@zihanw/pi-subagent-runtime").BackendDescriptor): SubagentBackendDescriptor {
	return {
		id: descriptor.id,
		version: descriptor.version,
		capabilities: {
			access: structuredClone(descriptor.capabilities.access),
			executionBoundaries: [...descriptor.capabilities.executionBoundaries],
			limits: structuredClone(descriptor.capabilities.limits) as SubagentBackendDescriptor["capabilities"]["limits"],
			cancellation: descriptor.capabilities.cancellation,
			mediaMimeTypes: [...descriptor.capabilities.mediaMimeTypes],
			traceInspection: false,
			artifactRetention: false,
			remoteTransport: descriptor.capabilities.remoteTransport,
			promptRuntimeFidelity: descriptor.capabilities.promptRuntimeFidelity,
		},
	};
}

function portableMessage(message: SubagentPreparedMessage): import("@zihanw/pi-subagent-runtime").PreparedMessage {
	return { role: message.role, content: structuredClone(message.content) };
}

function responseForHost(prepared: ForgeSubagentPreparedRun, result: RunResult): AgentResponse {
	const common = {
		schemaVersion: SUBAGENT_CONTRACT_VERSION,
		requestId: prepared.request.requestId,
		runId: result.runId,
		backendId: result.backendId,
		profileFingerprint: prepared.plan.profile.profileFingerprint,
		executionFingerprint: result.executionFingerprint,
		model: structuredClone(result.model),
		effectiveToolIds: [...result.effectiveToolIds],
		enforcement: {
			access: structuredClone(result.enforcement.access) as AgentResponse["enforcement"]["access"],
			limits: structuredClone(result.enforcement.limits) as AgentResponse["enforcement"]["limits"],
		},
		durationMs: result.durationMs,
		artifacts: [],
		...(result.usage ? { usage: structuredClone(result.usage) } : {}),
	};
	const partialOutput = result.output ? { text: result.output.text, partial: true as const } : undefined;
	switch (result.status) {
		case "completed":
			return { ...common, status: "completed", output: { text: result.output.text, partial: false } };
		case "failed":
			return { ...common, status: "failed", error: structuredClone(result.error), ...(partialOutput ? { output: partialOutput } : {}) };
		case "cancelled":
			return { ...common, status: "cancelled", reason: result.reason, ...(partialOutput ? { output: partialOutput } : {}) };
		case "timed-out":
			return { ...common, status: "timed-out", reason: result.reason, enforcedTimeoutMs: result.enforcedTimeoutMs, ...(partialOutput ? { output: partialOutput } : {}) };
		case "limit-reached":
			return { ...common, status: "limit-reached", reachedLimit: result.reachedLimit, ...(partialOutput ? { output: partialOutput } : {}) };
	}
}

function cancelReason(signal: AbortSignal): string {
	return typeof signal.reason === "string" && signal.reason ? signal.reason : "Subagent execution cancelled.";
}
