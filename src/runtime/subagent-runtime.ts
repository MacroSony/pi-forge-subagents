import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
	PI_BUBBLEWRAP_WRITE_TOOL_CATALOG,
	PiBubblewrapWriteBackend,
	type PiBubblewrapWriteBackendOptions,
} from "@zihanw/pi-subagent-runtime/backends/bubblewrap";
import {
	PI_INPROCESS_TOOL_CATALOG,
	PiInProcessBackend,
	type PiInProcessBackendOptions,
} from "@zihanw/pi-subagent-runtime/backends/inprocess";
import {
	SUBAGENT_CONTRACT_VERSION,
	createAgentExecutionPlan,
	hasSubagentErrors,
	negotiateSubagentTools,
	validateAgentProfileSnapshot,
	type AgentExecutionPlan,
	type AgentProfileSnapshot,
	type AgentRequest,
	type AgentResponse,
	type BackendPreflightAccepted,
	type SubagentBackendDescriptor,
	type SubagentDiagnostic,
	type SubagentPreparedMessage,
	type SubagentPreparationOutput,
	createProtectedSubagentTask,
} from "../contract/index.ts";
import type { ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import type { ForgeHostSession } from "../host/session.ts";
import {
	MAX_SUBAGENT_TIMEOUT_MS,
	MIN_SUBAGENT_TIMEOUT_MS,
	canonicalDelegationProfileId,
	isValidSubagentTimeoutMs,
	loadForgeSubagentSettings,
	profileAuthorizationHint,
	resolveSubagentProfilePolicy,
} from "../config/subagents.ts";

export interface ForgeSubagentPreparedRun {
	request: AgentRequest;
	preflight: BackendPreflightAccepted;
	plan: AgentExecutionPlan;
	diagnostics: SubagentDiagnostic[];
	/** The canonical target directory bound to this approval. */
	cwd?: string;
	/** The retained child selected for this turn, when this is a continuation. */
	continueId?: string;
	/** Retain the child after a successful turn. */
	keepContext?: boolean;
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

export interface ForgeSubagentRuntimePrepareOptions {
	backendId?: string;
	timeoutMs?: number;
	model?: { provider: string; id: string };
	cwd?: string;
	unattended?: boolean;
	/** Keep the in-process child session after a successful run. */
	keepContext?: boolean;
	/** Continue a previously retained in-process child session. */
	continueId?: string;
}

export interface ForgeSubagentRunHandle {
	readonly id: string;
	readonly result: Promise<AgentResponse>;
	cancel(reason?: string): Promise<void>;
}

export interface ForgeSubagentContinuationInfo {
	profileId: string;
	backendId: string;
	cwd: string;
}

export interface ForgeSubagentRuntime {
	backendIds(): string[];
	descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[];
	prepare(profileId: string, task: string, ctx: ExtensionContext, run?: ForgeSubagentRuntimePrepareOptions): Promise<ForgeSubagentPreparationResult>;
	discard(prepared: ForgeSubagentPreparedRun): Promise<void>;
	start?(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<ForgeSubagentRunHandle>;
	execute(prepared: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse>;
	releaseContinuation?(id: string, ctx: ExtensionContext): Promise<void>;
	continuationInfo?(id: string, ctx: ExtensionContext): ForgeSubagentContinuationInfo | undefined;
	takeReport?(runId: string): PiSubprocessRunReport | undefined;
	dispose(): Promise<void>;
}

interface ReportCapableBackend extends ExecutionBackend {
	takeReport(preparedRunId: string): PiSubprocessRunReport | undefined;
	releaseContinuation?(id: string): Promise<void> | void;
	dispose?(): Promise<void>;
}

type ContinuationAwareRuntime = ExecutionRuntime & {
	releaseContinuation?(id: string): Promise<void>;
};

type ContinuationIntent = ExecutionIntent & {
	continuation?: { retain: true; id?: string };
};

type ContinuationCompileContext = {
	history: import("@zihanw/pi-subagent-runtime").PreparedConversation;
};

type ContinuationAwarePrepareRequest = {
	backendId: string;
	intent: ContinuationIntent;
	signal?: AbortSignal;
	compile: (
		runtime: PromptRuntime,
		preflight: import("@zihanw/pi-subagent-runtime").BackendPreflightAccepted,
		continuation?: ContinuationCompileContext,
	) => Promise<import("@zihanw/pi-subagent-runtime").PreparedConversation>;
};

export interface ForgeSubagentRuntimeOptions {
	backendId?: string;
	subprocess?: Omit<PiSubprocessBackendOptions, "modelRegistry" | "cwd">;
	rpc?: Omit<PiRpcBackendOptions, "modelRegistry" | "cwd">;
	bubblewrap?: Omit<PiBubblewrapWriteBackendOptions, "modelRegistry" | "cwd" | "workspaceRoots">;
	inprocess?: Omit<PiInProcessBackendOptions, "modelRegistry" | "cwd">;
	/** Extra backends registered alongside the built-in subprocess/RPC/Bubblewrap backends (mainly for tests). */
	extraBackends?: ExecutionBackend[];
	/** When false, do not construct the built-in subprocess/RPC/Bubblewrap backends (tests inject their own). */
	builtInBackends?: boolean;
	/** Tool catalog used to build the execution intent (defaults to the read-only subprocess catalog). */
	intentToolCatalog?: BackendPreflightAccepted["toolCatalog"];
}

interface BackendIntentPreset {
	toolCatalog: BackendPreflightAccepted["toolCatalog"];
	access: {
		level: AgentRequest["access"]["level"];
		workspaceMode: AgentRequest["access"]["workspaces"][number]["mode"];
		network: AgentRequest["access"]["network"];
		allowProcess: boolean;
		executionBoundary: AgentRequest["access"]["executionBoundary"];
	};
}

interface RuntimeGeneration {
	runtime: ExecutionRuntime;
	backends: Map<string, ReportCapableBackend>;
	intentPresets: Map<string, BackendIntentPreset>;
	modelRegistry: ModelRegistry;
	parentCwd: string;
	targetCwd: string;
	sessionId: string;
	key: string;
	epoch: number;
}

interface RetainedContinuationRecord {
	id: string;
	generation: RuntimeGeneration;
	parentSessionId: string;
	profileId: string;
	backendId: string;
	cwd: string;
	canonicalTargetCwd: string;
	profileFingerprint: string;
	initialSystemPrompt: string;
	model: { provider: string; id: string };
}

interface PreparedRecord {
	generation: RuntimeGeneration;
	handle: PreparedRun;
	backend: ReportCapableBackend;
	targetCwd: string;
	canonicalTargetCwd: string;
	profileId: string;
	parentSessionId: string;
	profileFingerprint: string;
	continueId?: string;
	keepContext: boolean;
	unattended: boolean;
	policyBackendId: string;
	policyTimeoutMs: number;
	promptStackFingerprint: string | null;
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
	const generations = new Map<string, RuntimeGeneration>();
	const registryIds = new WeakMap<ModelRegistry, number>();
	let nextRegistryId = 1;
	let currentParentSessionId: string | undefined;
	let currentParentRegistry: ModelRegistry | undefined;
	let currentParentCwd: string | undefined;
	let lifecycleEpoch = 0;
	const continuations = new Map<string, RetainedContinuationRecord>();
	const MAX_TARGET_GENERATIONS = 16;
	const GENERATION_DISPOSAL_ATTEMPTS = 3;

	// Disposal of replaced generations is serialized through this chain; callers
	// that are about to use a fresh generation await it so teardown of the
	// previous generation cannot race the new one. Errors are caught and surfaced
	// (logged) so a failed disposal never wedges the chain or becomes an unhandled
	// rejection.
	let disposalChain: Promise<void> = Promise.resolve();
	const prepared = new Map<string, PreparedRecord>();
	const reports = new Map<string, { backend: ReportCapableBackend; preparedRunId: string }>();
	const freshProcessBackendIds = ["pi-subprocess-readonly", "pi-rpc-readonly", "pi-bwrap-write"];
	const backendIds = [...freshProcessBackendIds, "pi-inprocess"];

	function getRegistryId(registry: ModelRegistry | undefined): number {
		if (!registry || (typeof registry !== "object" && typeof registry !== "function")) return 0;
		let id = registryIds.get(registry);
		if (id === undefined) {
			id = nextRegistryId++;
			registryIds.set(registry, id);
		}
		return id;
	}

	function canonicalPath(p: string): string {
		try {
			return realpathSync(p);
		} catch {
			return resolve(p);
		}
	}

	async function disposeGeneration(target: RuntimeGeneration): Promise<void> {
		const runtime = target.runtime as ContinuationAwareRuntime;
		// beta.4 leaves backend disposal to the host. New runtimes own this call
		// (and also release retained continuations), so calling it here would
		// double-dispose the in-process backend.
		if (typeof runtime.releaseContinuation !== "function") {
			await runtime.dispose();
			await Promise.all([...target.backends.values()].map((backend) => backend.dispose?.()));
			return;
		}
		// New runtimes retry the backend cleanups that failed when dispose() is
		// called again. Make a small, bounded number of immediate attempts; the
		// last failure is surfaced instead of being reported as released.
		let lastError: unknown;
		for (let attempt = 0; attempt < GENERATION_DISPOSAL_ATTEMPTS; attempt++) {
			try {
				await runtime.dispose();
				return;
			} catch (disposeError) {
				lastError = disposeError;
			}
		}
		throw lastError;
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

	function ensure(ctx: ExtensionContext, targetDir?: string): RuntimeGeneration {
		const sessionId = typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "default";
		const parentCwd = canonicalPath(ctx.cwd);
		const effectiveTargetCwd = targetDir ? canonicalPath(targetDir) : parentCwd;

		const isParentMatch =
			currentParentSessionId === sessionId &&
			currentParentRegistry === ctx.modelRegistry &&
			currentParentCwd === parentCwd;

		if (!isParentMatch) {
			lifecycleEpoch++;
			for (const gen of generations.values()) {
				scheduleDisposal(gen);
			}
			generations.clear();
			prepared.clear();
			continuations.clear();
			currentParentSessionId = sessionId;
			currentParentRegistry = ctx.modelRegistry;
			currentParentCwd = parentCwd;
		}

		const key = `${sessionId}::reg_${getRegistryId(ctx.modelRegistry)}::${parentCwd}::${effectiveTargetCwd}`;
		const existing = generations.get(key);
		if (existing) return existing;

		// Never evict a generation implicitly: it may own an active run or a
		// retained child that is not represented by `prepared`.
		if (generations.size >= MAX_TARGET_GENERATIONS) {
			throw new Error(`Subagent target generation limit (${MAX_TARGET_GENERATIONS}) reached; use an existing target or start a new parent session.`);
		}

		const runtime = createExecutionRuntime();
		const backends = new Map<string, ReportCapableBackend>();
		const intentPresets = new Map<string, BackendIntentPreset>();
		const register = (backend: ReportCapableBackend, preset: BackendIntentPreset): void => {
			backends.set(backend.descriptor.id, backend);
			intentPresets.set(backend.descriptor.id, preset);
		};
		if (options.builtInBackends !== false) {
			const subprocess = new PiSubprocessBackend({
				modelRegistry: ctx.modelRegistry,
				cwd: effectiveTargetCwd,
				...options.subprocess,
			});
			const rpc = new PiRpcBackend({
				modelRegistry: ctx.modelRegistry,
				cwd: effectiveTargetCwd,
				...options.rpc,
			});
			const bubblewrap = new PiBubblewrapWriteBackend({
				modelRegistry: ctx.modelRegistry,
				cwd: effectiveTargetCwd,
				workspaceRoots: { project: effectiveTargetCwd },
				envForModel: (model) => bubblewrapModelEnvironment(ctx.modelRegistry, model),
				apiKeyForModel: (model) => bubblewrapModelApiKey(ctx.modelRegistry, model),
				...options.bubblewrap,
			});
			const inprocess = new PiInProcessBackend({
				modelRegistry: ctx.modelRegistry,
				cwd: effectiveTargetCwd,
				...options.inprocess,
			});
			register(subprocess, readOnlyIntentPreset());
			register(rpc, readOnlyIntentPreset());
			register(bubblewrap, bubblewrapWriteIntentPreset());
			register(inprocess, inProcessWriteIntentPreset());
		}
		for (const extra of options.extraBackends ?? []) {
			register(
				extra as ReportCapableBackend,
				readOnlyIntentPreset(options.intentToolCatalog ?? forgeToolCatalog()),
			);
		}
		for (const backend of backends.values()) runtime.registerBackend(backend);
		const gen: RuntimeGeneration = {
			runtime,
			backends,
			intentPresets,
			modelRegistry: ctx.modelRegistry,
			parentCwd,
			targetCwd: effectiveTargetCwd,
			sessionId,
			key,
			epoch: lifecycleEpoch,
		};
		generations.set(key, gen);
		return gen;
	}

	function descriptors(ctx: ExtensionContext): SubagentBackendDescriptor[] {
		return ensure(ctx).runtime.listBackends().map(descriptorForHost);
	}

	async function prepare(profileId: string, task: string, ctx: ExtensionContext, run?: ForgeSubagentRuntimePrepareOptions): Promise<ForgeSubagentPreparationResult> {
		const diagnostics: SubagentDiagnostic[] = [];
		if (!ctx.isProjectTrusted()) {
			return { ok: false, diagnostics: [error("host.trust", "Project is not trusted; subagent profiles remain disabled.")] };
		}
		const session = sessionProvider();
		if (!session) {
			return { ok: false, diagnostics: [error("host.session", "No pi-forge host session; start a session first.")] };
		}
		const canonicalProfileId = canonicalDelegationProfileId(profileId);
		const parentSessionId = ctx.sessionManager.getSessionId();
		const retained = run?.continueId ? continuations.get(run.continueId) : undefined;
		if (run?.continueId && !retained) {
			return { ok: false, diagnostics: [error("continuation.unknown", `Unknown continuation handle: ${run.continueId}.`)] };
		}
		if (retained && retained.parentSessionId !== parentSessionId) {
			return { ok: false, diagnostics: [error("continuation.session", "Continuation handles are private to their owning parent session.")] };
		}
		if (retained && retained.profileId !== canonicalProfileId) {
			return { ok: false, diagnostics: [error("continuation.profile", "Continuation profile changed; prepare a new child.")] };
		}
		if (retained && run?.backendId && run.backendId !== retained.backendId) {
			return { ok: false, diagnostics: [error("continuation.backend", "Continuation backend changed; prepare a new child.")] };
		}
		if (retained && run?.cwd !== undefined && canonicalPath(isAbsolute(run.cwd) ? resolve(run.cwd) : resolve(ctx.cwd, run.cwd)) !== retained.canonicalTargetCwd) {
			return { ok: false, diagnostics: [error("continuation.cwd", "Continuation working directory changed; prepare a new child.")] };
		}
		const settings = loadForgeSubagentSettings(ctx);
		const policy = resolveSubagentProfilePolicy(settings, canonicalProfileId);
		if (!policy.enabled) {
			const hint = profileAuthorizationHint(settings, canonicalProfileId);
			return {
				ok: false,
				diagnostics: [error("host.profile-disabled", `Agent profile "${profileId}" is not enabled for subagent delegation in subagents.json.${hint ? ` ${hint}` : ""}`)],
			};
		}
		const timeoutMs = run?.timeoutMs ?? policy.timeout.milliseconds;
		if (!isValidSubagentTimeoutMs(timeoutMs)) {
			return {
				ok: false,
				diagnostics: [error("host.timeout", `Subagent timeout must be an integer from ${MIN_SUBAGENT_TIMEOUT_MS} to ${MAX_SUBAGENT_TIMEOUT_MS} milliseconds.`)],
			};
		}

		let canonicalParentCwd: string;
		try {
			canonicalParentCwd = realpathSync(ctx.cwd);
		} catch {
			canonicalParentCwd = resolve(ctx.cwd);
		}

		let canonicalTargetCwd = retained?.canonicalTargetCwd ?? canonicalParentCwd;
		let targetCwd = retained?.cwd ?? ctx.cwd;

		if (run?.cwd !== undefined) {
			if (typeof run.cwd !== "string" || !run.cwd.trim()) {
				return {
					ok: false,
					diagnostics: [error("host.cwd-invalid", "Target working directory must be a non-empty string path.")],
				};
			}
			const resolvedTarget = isAbsolute(run.cwd) ? resolve(run.cwd) : resolve(ctx.cwd, run.cwd);
			if (!existsSync(resolvedTarget)) {
				return {
					ok: false,
					diagnostics: [error("host.cwd-missing", `Target working directory does not exist: ${run.cwd}`)],
				};
			}
			try {
				const stat = statSync(resolvedTarget);
				if (!stat.isDirectory()) {
					return {
						ok: false,
						diagnostics: [error("host.cwd-invalid", `Target working directory is not a directory: ${run.cwd}`)],
					};
				}
				canonicalTargetCwd = realpathSync(resolvedTarget);
				targetCwd = resolvedTarget;
			} catch (err) {
				return {
					ok: false,
					diagnostics: [error("host.cwd-invalid", `Target working directory cannot be resolved: ${err instanceof Error ? err.message : String(err)}`)],
				};
			}
		}

		const isParentCwd = canonicalTargetCwd === canonicalParentCwd;
		const isAllowed = isParentCwd || (settings.allowedWorkingDirectories?.includes(canonicalTargetCwd) ?? false);
		const isUnattended = run?.unattended ?? Boolean(settings.allowAgentInvocationWithoutApproval);

		if (isUnattended && !isAllowed) {
			return {
				ok: false,
				diagnostics: [
					error(
						"host.cwd-forbidden",
						`Target working directory "${canonicalTargetCwd}" is not on the allowed working directories list for unattended invocation.`,
					),
				],
			};
		}

		const current = ensure(ctx, canonicalTargetCwd);
		const prepareEpoch = current.epoch;
		// A replaced generation must finish tearing down before we start preparing
		// against the fresh generation.
		await disposalChain;
		if (prepareEpoch !== lifecycleEpoch || current.epoch !== lifecycleEpoch) {
			return { ok: false, diagnostics: [error("runtime.stale", "Subagent preparation was superseded by a parent session or target change.")] };
		}

		let snapshot: AgentProfileSnapshot;
		try {
			const resolved = await session.resolveProfile(canonicalProfileId);
			// Deep structural validation at the boundary, before the snapshot feeds
			// the execution intent or backend preflight. The host port only
			// guarantees the wire envelope; the full local contract check runs here
			// (and again inside plan creation as an integrity net).
			const snapshotDiagnostics = validateAgentProfileSnapshot(resolved.snapshot);
			if (hasSubagentErrors(snapshotDiagnostics)) {
				diagnostics.push(...snapshotDiagnostics);
				return { ok: false, diagnostics };
			}
			snapshot = resolved.snapshot as AgentProfileSnapshot;
		} catch (resolveError) {
			diagnostics.push(error("host.profile-missing", resolveError instanceof Error ? resolveError.message : String(resolveError)));
			return { ok: false, diagnostics };
		}

		if (prepareEpoch !== lifecycleEpoch) {
			return { ok: false, diagnostics: [error("runtime.stale", "Parent session changed during profile resolution.")] };
		}

		const backendId = run?.backendId ?? retained?.backendId ?? options.backendId ?? policy.backend.id;
		const backend = current.backends.get(backendId);
		const intentPreset = current.intentPresets.get(backendId);
		if (!backend || !intentPreset) return { ok: false, diagnostics: [error("host.backend", `Backend is not registered: ${backendId}`)] };
		if (run?.continueId || run?.keepContext) {
			if (backendId !== "pi-inprocess" || !continuationRuntimeSupported(current, backend)) {
				return { ok: false, diagnostics: [error("continuation.unsupported", "Context continuation is supported only by the new pi-inprocess runtime/backend; install the matching pi-subagent-runtime release.")] };
			}
		}
		const request: AgentRequest = {
			schemaVersion: SUBAGENT_CONTRACT_VERSION,
			requestId: `request:${randomUUID()}`,
			profileId: canonicalProfileId,
			expectedProfileFingerprint: snapshot.profileFingerprint,
			input: { text: task },
			access: {
				level: intentPreset.access.level,
				workspaces: [{ handle: "project", mode: intentPreset.access.workspaceMode }],
				workingDirectory: { workspaceHandle: "project", path: "." },
				network: intentPreset.access.network,
				allowProcess: intentPreset.access.allowProcess,
				executionBoundary: intentPreset.access.executionBoundary,
			},
			limits: { timeoutMs: { value: timeoutMs, enforcement: "best-effort" } },
			resultProjection: { maxChars: 12_000 },
			parent: { sessionId: parentSessionId, depth: 0, maxDepth: 1 },
			remoteEgressConsent: true,
		};
		if (retained && retained.profileFingerprint !== snapshot.profileFingerprint) {
			return { ok: false, diagnostics: [error("continuation.profile-changed", "Profile changed; start a new child.")] };
		}
		if (retained && isUnattended && (retained.backendId !== policy.backend.id || retained.model.provider !== snapshot.profile.model.provider || retained.model.id !== snapshot.profile.model.id)) {
			return { ok: false, diagnostics: [error("continuation.policy-changed", "Unattended continuation must still match its configured backend/model.")] };
		}
		const retainedOverride = retained && (retained.model.provider !== snapshot.profile.model.provider || retained.model.id !== snapshot.profile.model.id)
			? retained.model
			: undefined;
		const selectedModel = run?.model ?? retainedOverride ?? snapshot.profile.model;
		if (retained && (selectedModel.provider !== retained.model.provider || selectedModel.id !== retained.model.id)) {
			return { ok: false, diagnostics: [error("continuation.model", "Continuation model changed; prepare a new child.")] };
		}
		const effectiveModelOverride = run?.model ?? retainedOverride;
		const intent = executionIntentFor(request, snapshot, intentPreset.toolCatalog, effectiveModelOverride, canonicalTargetCwd);
		if (run?.continueId || run?.keepContext) {
			(intent as ContinuationIntent).continuation = {
				retain: true,
				...(run.continueId ? { id: run.continueId } : {}),
			};
		}
		const portability = modelPortabilityDiagnostic(ctx.modelRegistry, intent.model, backendId, freshProcessBackendIds);
		if (portability) {
			diagnostics.push(portability);
			return { ok: false, diagnostics };
		}

		let hostPreparation: SubagentPreparationOutput | undefined;
		let handle: PreparedRun;
		try {
			const prepareRequest: ContinuationAwarePrepareRequest = {
				backendId,
				intent: intent as ContinuationIntent,
				...(ctx.signal ? { signal: ctx.signal } : {}),
				compile: async (
					promptRuntime: PromptRuntime,
					acceptedPreflight: import("@zihanw/pi-subagent-runtime").BackendPreflightAccepted,
					continuationContext?: ContinuationCompileContext,
				) => {
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
					if (continuationContext) {
						// The backend owns the raw transcript. Reauthorization above is
						// deliberate, but its freshly compiled old task must never replace
						// that transcript. Only append this turn's task exactly once.
						if (preparedResponse.systemPrompt !== continuationContext.history.systemPrompt
							|| (retained && preparedResponse.systemPrompt !== retained.initialSystemPrompt)) {
							throw new Error("Continuation system prompt changed; task-dependent prompts are not supported. Prepare a new child.");
						}
						const messages = [
							...continuationContext.history.messages.map((message) => ({ role: message.role, content: structuredClone(message.content) })),
							createProtectedSubagentTask(request.input),
						] as SubagentPreparedMessage[];
						hostPreparation = toPreparationOutput(preparedResponse, messages);
						return { systemPrompt: continuationContext.history.systemPrompt, messages: messages.map(portableMessage) };
					}
					hostPreparation = toPreparationOutput(preparedResponse);
					return {
						systemPrompt: preparedResponse.systemPrompt,
						messages: preparedResponse.messages.map(portableMessage),
					};
				},
			};
			// The installed beta.4 types do not expose the third compiler argument;
			// the structural call is intentional and only reached after capability
			// detection above.
			handle = await (current.runtime as unknown as { prepare(request: ContinuationAwarePrepareRequest): Promise<PreparedRun> }).prepare(prepareRequest);
		} catch (prepareError) {
			const nested = (prepareError as { diagnostics?: unknown }).diagnostics;
			if (Array.isArray(nested)) {
				diagnostics.push(...(nested as SubagentDiagnostic[]));
			} else {
				diagnostics.push(error("host.preparation", prepareError instanceof Error ? prepareError.message : String(prepareError)));
			}
			return { ok: false, diagnostics };
		}

		if (prepareEpoch !== lifecycleEpoch || current.epoch !== lifecycleEpoch) {
			await handle.discard().catch(() => undefined);
			return { ok: false, diagnostics: [error("runtime.stale", "Subagent preparation was superseded while awaiting backend preparation.")] };
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
			...(effectiveModelOverride ? { modelOverride: effectiveModelOverride } : {}),
			conversationFingerprint: sealed.conversationFingerprint,
			executionFingerprint: sealed.executionFingerprint,
		});
		diagnostics.push(...planned.diagnostics);
		if (!planned.plan || hasSubagentErrors(diagnostics)) {
			await handle.discard();
			return { ok: false, diagnostics };
		}
		prepared.set(handle.id, {
			generation: current,
			handle,
			backend,
			targetCwd,
			canonicalTargetCwd,
			profileId: canonicalProfileId,
			parentSessionId,
			profileFingerprint: snapshot.profileFingerprint,
			...(run?.continueId ? { continueId: run.continueId } : {}),
			keepContext: Boolean(run?.keepContext || run?.continueId),
			unattended: isUnattended,
			policyBackendId: policy.backend.id,
			policyTimeoutMs: policy.timeout.milliseconds,
			promptStackFingerprint: snapshot.promptStackFingerprint,
		});
		return {
			ok: true,
			prepared: {
				request,
				preflight: planned.plan.preflight,
				plan: planned.plan,
				diagnostics,
				cwd: canonicalTargetCwd,
				...(run?.continueId ? { continueId: run.continueId } : {}),
				...((run?.keepContext || run?.continueId) ? { keepContext: true } : {}),
			},
		};
	}

	async function discard(preparedRun: ForgeSubagentPreparedRun): Promise<void> {
		const record = prepared.get(preparedRun.plan.runId);
		if (!record) return;
		prepared.delete(preparedRun.plan.runId);
		await record.handle.discard();
	}

	async function reauthorizeAfterApproval(record: PreparedRecord, preparedRun: ForgeSubagentPreparedRun, ctx: ExtensionContext): Promise<void> {
		if (!ctx.isProjectTrusted()) throw new Error("Project trust was revoked after approval.");
		const session = sessionProvider();
		if (!session) throw new Error("Forge host session is no longer available.");
		const resolved = await session.resolveProfile(record.profileId);
		// No asynchronous boundary follows these live authorization checks.
		if (!ctx.isProjectTrusted()) throw new Error("Project trust was revoked after approval.");
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== record.parentSessionId) throw new Error("Parent session changed after approval.");
		const settings = loadForgeSubagentSettings(ctx);
		const policy = resolveSubagentProfilePolicy(settings, record.profileId);
		if (!policy.enabled) throw new Error(`Agent profile "${record.profileId}" is no longer enabled.`);
		if (record.unattended && !settings.allowAgentInvocationWithoutApproval) throw new Error("Unattended approval was revoked before execution.");
		if (record.unattended && record.canonicalTargetCwd !== canonicalPath(ctx.cwd)
			&& !(settings.allowedWorkingDirectories?.includes(record.canonicalTargetCwd) ?? false)) {
			throw new Error(`Target working directory "${record.canonicalTargetCwd}" is no longer allowed.`);
		}
		const diagnostics = validateAgentProfileSnapshot(resolved.snapshot);
		if (hasSubagentErrors(diagnostics)) throw new Error("The current profile snapshot is invalid.");
		if (resolved.snapshot.profileFingerprint !== record.profileFingerprint ||
			resolved.snapshot.promptStackFingerprint !== record.promptStackFingerprint) {
			throw new Error("Agent profile changed after approval; prepare a new child.");
		}
		if (policy.backend.id !== record.policyBackendId || policy.timeout.milliseconds !== record.policyTimeoutMs) {
			throw new Error("Configured backend changed after approval; prepare a new child.");
		}
		if (preparedRun.plan.backendId !== record.backend.descriptor.id) {
			throw new Error("Prepared backend binding changed after approval.");
		}
	}

	async function start(preparedRun: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<ForgeSubagentRunHandle> {
		const record = prepared.get(preparedRun.plan.runId);
		if (!record) throw new Error("Subagent prepared run is unknown to this runtime generation.");
		let currentCanonical: string;
		try { currentCanonical = realpathSync(record.targetCwd); }
		catch { throw new Error(`Target working directory no longer exists: ${record.targetCwd}`); }
		if (currentCanonical !== record.canonicalTargetCwd) {
			throw new Error(`Target working directory realpath changed since preparation (symlink drift detected): expected ${record.canonicalTargetCwd}, got ${currentCanonical}`);
		}
		if (preparedRun.cwd !== undefined && preparedRun.cwd !== record.canonicalTargetCwd) {
			throw new Error(`Prepared run cwd mismatch: expected ${record.canonicalTargetCwd}, got ${preparedRun.cwd}`);
		}
		const current = ensure(ctx, record.targetCwd);
		const startEpoch = current.epoch;
		await disposalChain;
		if (record.generation !== current || startEpoch !== lifecycleEpoch || current.epoch !== lifecycleEpoch) {
			throw new Error("Subagent prepared run belongs to a previous runtime generation.");
		}
		await reauthorizeAfterApproval(record, preparedRun, ctx);
		if (startEpoch !== lifecycleEpoch) throw new Error("Subagent execution was superseded by a session change.");
		// Repeat path binding after all awaited authorization work, not merely
		// before it. This is a boundary check, not an OS-atomic path guarantee.
		if (realpathSync(record.targetCwd) !== record.canonicalTargetCwd) {
			throw new Error("Target working directory realpath changed during approval (symlink drift detected).");
		}
		if (!statSync(record.canonicalTargetCwd).isDirectory()) throw new Error("Target working directory no longer exists.");
		prepared.delete(preparedRun.plan.runId);
		const run = current.runtime.execute(record.handle);
		reports.set(run.id, { backend: record.backend, preparedRunId: record.handle.id });
		const subscription = onUpdate ? run.subscribe((event) => onUpdate({
			phase: event.phase,
			message: event.message,
			...(event.details === undefined ? {} : { details: event.details }),
		})) : undefined;
		let cancelOnAbort: (() => void) | undefined;
		if (signal) {
			cancelOnAbort = () => { void run.cancel(cancelReason(signal)); };
			if (signal.aborted) cancelOnAbort();
			else signal.addEventListener("abort", cancelOnAbort, { once: true });
		}
		const result = (async (): Promise<AgentResponse> => {
			try {
				const response = responseForHost(preparedRun, await run.result);
				if (record.continueId && !response.continuationId) continuations.delete(record.continueId);
				if (response.continuationId && startEpoch === lifecycleEpoch && generations.get(current.key) === current) {
					const prior = record.continueId ? continuations.get(record.continueId) : undefined;
					continuations.set(response.continuationId, {
						id: response.continuationId,
						generation: record.generation,
						parentSessionId: record.parentSessionId,
						profileId: record.profileId,
						backendId: record.backend.descriptor.id,
						cwd: record.targetCwd,
						canonicalTargetCwd: record.canonicalTargetCwd,
						profileFingerprint: record.profileFingerprint,
						initialSystemPrompt: prior?.initialSystemPrompt ?? preparedRun.plan.systemPrompt,
						model: prior?.model ?? structuredClone(preparedRun.plan.model),
					});
				}
				return response;
			} finally {
				if (signal && cancelOnAbort) signal.removeEventListener("abort", cancelOnAbort);
				subscription?.dispose();
			}
		})();
		return { id: run.id, result, cancel: (reason?: string) => run.cancel(reason) };
	}

	async function execute(preparedRun: ForgeSubagentPreparedRun, ctx: ExtensionContext, signal?: AbortSignal, onUpdate?: (update: SubagentBackendExecutionUpdate) => void): Promise<AgentResponse> {
		const running = await start(preparedRun, ctx, signal, onUpdate);
		return running.result;
	}

	function continuationInfo(id: string, ctx: ExtensionContext): ForgeSubagentContinuationInfo | undefined {
		const record = continuations.get(id);
		if (!record || record.parentSessionId !== ctx.sessionManager.getSessionId()) return undefined;
		if (canonicalPath(ctx.cwd) !== record.generation.parentCwd || record.generation !== generations.get(record.generation.key)) return undefined;
		return { profileId: record.profileId, backendId: record.backendId, cwd: record.canonicalTargetCwd };
	}

	async function releaseContinuation(id: string, ctx: ExtensionContext): Promise<void> {
		const record = continuations.get(id);
		if (!record) throw new Error(`Unknown continuation handle: ${id}.`);
		if (record.parentSessionId !== ctx.sessionManager.getSessionId() || canonicalPath(ctx.cwd) !== record.generation.parentCwd) {
			throw new Error("Continuation handles are private to their owning parent session.");
		}
		const runtime = record.generation.runtime as ContinuationAwareRuntime;
		const backend = record.generation.backends.get(record.backendId);
		if (typeof runtime.releaseContinuation !== "function" || typeof backend?.releaseContinuation !== "function") {
			throw new Error("Continuation release requires the new pi-subagent-runtime and pi-inprocess backend release hooks.");
		}
		await runtime.releaseContinuation(id);
		continuations.delete(id);
	}

	function takeReport(runId: string): PiSubprocessRunReport | undefined {
		const location = reports.get(runId);
		if (!location) return undefined;
		reports.delete(runId);
		return location.backend.takeReport(location.preparedRunId);
	}

	async function dispose(): Promise<void> {
		lifecycleEpoch++;
		prepared.clear();
		reports.clear();
		continuations.clear();
		const all = [...generations.values()];
		generations.clear();
		currentParentSessionId = undefined;
		currentParentRegistry = undefined;
		currentParentCwd = undefined;
		for (const target of all) {
			await disposeGeneration(target).catch((disposeError: unknown) => surfaceDisposalError("runtime disposal failed", disposeError));
		}
		// Drain any replaced generations still finishing teardown.
		await disposalChain;
	}

	return { backendIds: () => [...backendIds], descriptors, prepare, discard, start, execute, releaseContinuation, continuationInfo, takeReport, dispose };
}

function toPreparationOutput(prepared: ForgePrepareResponse, messages: SubagentPreparedMessage[] = prepared.messages as SubagentPreparedMessage[]): SubagentPreparationOutput {
	return {
		systemPrompt: prepared.systemPrompt,
		messages,
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
		diagnostics: prepared.diagnostics,
	};
}

function continuationRuntimeSupported(generation: RuntimeGeneration, backend: ReportCapableBackend): boolean {
	const capabilities = backend.descriptor.capabilities as typeof backend.descriptor.capabilities & { continuation?: boolean };
	return capabilities.continuation === true
		&& typeof (generation.runtime as ContinuationAwareRuntime).releaseContinuation === "function"
		&& typeof backend.releaseContinuation === "function";
}

function executionIntentFor(
	request: AgentRequest,
	snapshot: AgentProfileSnapshot,
	toolCatalog: BackendPreflightAccepted["toolCatalog"],
	modelOverride?: { provider: string; id: string },
	targetCwd?: string,
): ExecutionIntent {
	const negotiation = negotiateSubagentTools(
		toolCatalog,
		snapshot.promptStack?.tools,
		request.access,
	);
	return {
		model: structuredClone(modelOverride ?? snapshot.profile.model),
		thinkingLevel: snapshot.profile.thinkingLevel,
		requestedTools: negotiation.effectiveToolNames,
		access: {
			level: request.access.level,
			executionBoundary: request.access.executionBoundary,
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
			...(targetCwd ? { targetCwd } : {}),
		},
	};
}

function readOnlyIntentPreset(
	toolCatalog: BackendPreflightAccepted["toolCatalog"] = forgeToolCatalog(),
): BackendIntentPreset {
	return {
		toolCatalog,
		access: {
			level: "read-only",
			workspaceMode: "read-only",
			network: "allow",
			allowProcess: false,
			executionBoundary: "shared-user",
		},
	};
}

function bubblewrapWriteIntentPreset(): BackendIntentPreset {
	return {
		toolCatalog: PI_BUBBLEWRAP_WRITE_TOOL_CATALOG.map((tool) => ({
			...structuredClone(tool),
			effects: [...tool.effects],
		})) as BackendPreflightAccepted["toolCatalog"],
		access: {
			level: "workspace-write",
			workspaceMode: "read-write",
			network: "allow",
			allowProcess: true,
			executionBoundary: "isolated",
		},
	};
}

/**
 * In-process preset: same tool surface as the Bubblewrite write preset, but a
 * shared-user boundary with no OS isolation. This is the backend that can run
 * extension-registered providers (OAuth, custom streamSimple), because the
 * session executes against the host model runtime directly.
 */
function inProcessWriteIntentPreset(): BackendIntentPreset {
	return {
		toolCatalog: PI_INPROCESS_TOOL_CATALOG.map((tool) => ({
			...structuredClone(tool),
			effects: [...tool.effects],
		})) as BackendPreflightAccepted["toolCatalog"],
		access: {
			level: "workspace-write",
			workspaceMode: "read-write",
			network: "allow",
			allowProcess: true,
			executionBoundary: "shared-user",
		},
	};
}

interface ProviderEnvironmentPolicy {
	apiKey: string;
	ambient: readonly string[];
	bearer?: string;
}

const BUBBLEWRAP_PROVIDER_ENV: Readonly<Record<string, ProviderEnvironmentPolicy>> = {
	anthropic: {
		apiKey: "ANTHROPIC_API_KEY",
		ambient: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"],
		bearer: "ANTHROPIC_AUTH_TOKEN",
	},
	openai: { apiKey: "OPENAI_API_KEY", ambient: ["OPENAI_API_KEY"] },
	google: { apiKey: "GEMINI_API_KEY", ambient: ["GEMINI_API_KEY"] },
	openrouter: { apiKey: "OPENROUTER_API_KEY", ambient: ["OPENROUTER_API_KEY"] },
	opencode: { apiKey: "OPENCODE_API_KEY", ambient: ["OPENCODE_API_KEY"] },
	"opencode-go": { apiKey: "OPENCODE_API_KEY", ambient: ["OPENCODE_API_KEY"] },
};

async function bubblewrapModelApiKey(
	modelRegistry: ModelRegistry,
	modelRef: Readonly<{ provider: string; id: string }>,
): Promise<string | undefined> {
	const model = modelRegistry.find(modelRef.provider, modelRef.id);
	if (!model) return undefined;
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;
	if (auth.apiKey) return auth.apiKey;
	const authorization = Object.entries(auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return authorization ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}

async function bubblewrapModelEnvironment(
	modelRegistry: ModelRegistry,
	modelRef: Readonly<{ provider: string; id: string }>,
): Promise<Record<string, string>> {
	const policy = BUBBLEWRAP_PROVIDER_ENV[modelRef.provider];
	const env: Record<string, string> = {};
	for (const name of policy?.ambient ?? []) {
		const value = process.env[name];
		if (value) env[name] = value;
	}
	const model = modelRegistry.find(modelRef.provider, modelRef.id);
	if (!model) return env;
	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return env;
	Object.assign(env, auth.env ?? {});
	if (policy && auth.apiKey) env[policy.apiKey] = auth.apiKey;
	if (policy?.bearer) {
		const authorization = Object.entries(auth.headers ?? {}).find(
			([name]) => name.toLowerCase() === "authorization",
		)?.[1];
		const bearer = authorization ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
		if (bearer) env[policy.bearer] = bearer;
	}
	return env;
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
			...((descriptor.capabilities as { continuation?: boolean }).continuation === true ? { continuation: true } : {}),
			mediaMimeTypes: [...descriptor.capabilities.mediaMimeTypes],
			traceInspection: false,
			artifactRetention: false,
			remoteTransport: descriptor.capabilities.remoteTransport,
			promptRuntimeFidelity: descriptor.capabilities.promptRuntimeFidelity,
			...((descriptor.capabilities as typeof descriptor.capabilities & { continuation?: boolean }).continuation === undefined
				? {}
				: { continuation: (descriptor.capabilities as typeof descriptor.capabilities & { continuation?: boolean }).continuation }),
		},
	};
}

function portableMessage(message: SubagentPreparedMessage): import("@zihanw/pi-subagent-runtime").PreparedMessage {
	return { role: message.role, content: structuredClone(message.content) };
}

function responseForHost(prepared: ForgeSubagentPreparedRun, result: RunResult): AgentResponse {
	const continuationId = (result as RunResult & { continuationId?: string }).continuationId;
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
		...(continuationId ? { continuationId } : {}),
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

interface PortabilityProbeRegistry {
	getRegisteredProviderIds?: () => readonly string[];
	getRegisteredNativeProvider?: (provider: string) => unknown;
	getRegisteredProviderConfig?: (provider: string) => unknown;
}

/**
 * Fail fast when a fresh-process backend is asked to run a model whose
 * provider only exists in this process. Fresh-process backends start the
 * child with --no-extensions, so extension-registered providers can never
 * resolve there; without this check the run fails late with a confusing
 * "model not found" from the child.
 */
function modelPortabilityDiagnostic(
	modelRegistry: ModelRegistry,
	model: Readonly<{ provider: string; id: string }>,
	backendId: string,
	freshProcessBackendIds: readonly string[],
): SubagentDiagnostic | undefined {
	if (!freshProcessBackendIds.includes(backendId)) return undefined;
	const registry = modelRegistry as ModelRegistry & PortabilityProbeRegistry;
	let extensionRegistered = false;
	if (typeof registry.getRegisteredProviderIds === "function") {
		const ids: unknown = registry.getRegisteredProviderIds();
		if (Array.isArray(ids) && ids.includes(model.provider)) extensionRegistered = true;
	}
	if (!extensionRegistered && typeof registry.getRegisteredNativeProvider === "function") {
		extensionRegistered = Boolean(registry.getRegisteredNativeProvider(model.provider));
	}
	let config: Record<string, unknown> | undefined;
	if (typeof registry.getRegisteredProviderConfig === "function") {
		const raw: unknown = registry.getRegisteredProviderConfig(model.provider);
		config = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
		if (config) extensionRegistered = true;
	}
	if (!extensionRegistered) return undefined;

	const looksDeclarative = config !== undefined &&
		typeof config.streamSimple !== "function" &&
		config.oauth === undefined &&
		typeof config.refreshModels !== "function";
	return error(
		"host.model-not-portable",
		`Provider "${model.provider}" is registered by a Pi extension. Fresh-process backends start the child with --no-extensions, so this provider cannot resolve there. Use a built-in or models.json-declared provider for this profile, or route the profile to the pi-inprocess backend.` +
			(looksDeclarative ? " The registration looks declarative (no custom streaming or OAuth)." : ""),
	);
}
