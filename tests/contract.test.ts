import assert from "node:assert/strict";
import test from "node:test";
import {
	SUBAGENT_CONTRACT_VERSION,
	appendProtectedSubagentTask,
	budgetSubagentContext,
	canonicalSubagentJson,
	createAgentExecutionPlan,
	createProtectedSubagentTask,
	hasSubagentErrors,
	isProtectedSubagentTaskPreserved,
	negotiateSubagentTools,
	prepareSubagentInitialMessages,
	renderSubagentSelectedContext,
	subagentFingerprint,
	subagentPromptRuntimeFingerprint,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	validateAgentExecutionPlan,
	validateAgentProfileSnapshot,
	validateAgentRequest,
	validateAgentResponse,
	validateBackendPreflight,
	validateSubagentArtifactReference,
	validateSubagentTraceReference,
	type AgentExecutionPlan,
	type AgentProfile,
	type AgentProfileSnapshot,
	type AgentRequest,
	type AgentResponse,
	type BackendPreflightAccepted,
	type PromptStack,
	type SubagentAccessCapabilities,
	type SubagentBackendTool,
	type SubagentPreparedMessage,
	type SubagentPreparationRuntime,
} from "../src/contract/index.ts";

const DIGEST = subagentFingerprint("fixture");
const CONVERSATION_DIGEST = subagentFingerprint("fixture-conversation");
const EXECUTION_DIGEST = subagentFingerprint("fixture-execution");

function preparationRuntime(fidelity: SubagentPreparationRuntime["fidelity"] = "backend-assisted"): SubagentPreparationRuntime {
	const runtime: Omit<SubagentPreparationRuntime, "promptRuntimeFingerprint"> = {
		baseSystemPrompt: "base",
		options: {
			selectedTools: [],
			toolSnippets: {},
			promptGuidelines: [],
			cwd: ".",
			contextFiles: [],
			skills: [],
		},
		model: { provider: "test", id: "model" },
		preparedAt: "2026-07-14T00:00:00.000Z",
		fidelity,
	};
	return { ...runtime, promptRuntimeFingerprint: subagentPromptRuntimeFingerprint(runtime) };
}

function profile(promptStack: string | null = "worker"): AgentProfile {
	return {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "worker",
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		promptStack,
	};
}

function promptStackFixture(): PromptStack {
	return {
		id: "worker",
		tools: { allow: ["read", "paint_*"] },
	};
}

/**
 * Host-issued snapshot fixture. The real snapshot is built by the main
 * package's host resolution; the execution contract only needs the wire shape
 * plus content fingerprints.
 */
function snapshot(): AgentProfileSnapshot {
	const resolvedProfile = profile();
	const stack = promptStackFixture();
	return {
		schemaVersion: SUBAGENT_CONTRACT_VERSION,
		profileId: "project:worker",
		profile: resolvedProfile,
		promptStackId: "project:worker",
		promptStack: stack,
		dependencies: [
			{ kind: "macro", name: "customMacro", identity: "macro:fixture:customMacro", source: "fixture" },
			{ kind: "slot", name: "custom-slot", identity: "slot:fixture:custom-slot", source: "fixture" },
		],
		profileFingerprint: subagentSourceProfileFingerprint(resolvedProfile),
		promptStackFingerprint: subagentPromptStackFingerprint(stack),
	};
}

function request(overrides: Partial<AgentRequest> = {}): AgentRequest {
	return {
		schemaVersion: SUBAGENT_CONTRACT_VERSION,
		requestId: "req-1",
		profileId: "project:worker",
		input: { text: "Do the task." },
		access: { level: "none", workspaces: [], network: "deny", executionBoundary: "isolated" },
		limits: { timeoutMs: { value: 1_000, enforcement: "best-effort" } },
		resultProjection: { maxChars: 4_000 },
		parent: { depth: 0, maxDepth: 2 },
		remoteEgressConsent: false,
		...overrides,
	};
}

const ACCESS_CAPABILITIES: SubagentAccessCapabilities = {
	readOnlyMountIsolation: true,
	readWriteMountIsolation: true,
	symlinkSafeContainment: true,
	processIsolation: true,
	agentNetworkIsolation: true,
};

function preflight(overrides: Partial<BackendPreflightAccepted> = {}): BackendPreflightAccepted {
	return {
		status: "accepted",
		preflightId: "preflight-1",
		backend: {
			id: "fake-backend",
			version: "1.0.0",
			capabilities: {
				access: ACCESS_CAPABILITIES,
				executionBoundaries: ["isolated", "shared-user"],
				limits: {
					timeoutMs: ["backend-hard", "host-abort"],
					maxTurns: ["backend-hard"],
					tokenBudget: ["backend-hard"],
					maxOutputBytes: ["backend-hard"],
				},
				cancellation: true,
				mediaMimeTypes: ["image/png"],
				traceInspection: true,
				artifactRetention: true,
				remoteTransport: false,
				promptRuntimeFidelity: "backend-assisted",
			},
		},
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		toolCatalog: [],
		access: {
			level: "none",
			mounts: [],
			network: "deny",
			process: false,
			executionBoundary: "isolated",
			enforcement: ACCESS_CAPABILITIES,
		},
		limits: { timeoutMs: { value: 1_000, enforcement: "host-abort" } },
		diagnostics: [],
		...overrides,
	};
}

test("canonical fingerprints are key-order stable and reject non-finite or cyclic values", () => {
	assert.equal(canonicalSubagentJson({ z: 1, a: { d: 2, b: 1 }, omitted: undefined }), '{"a":{"b":1,"d":2},"z":1}');
	assert.equal(subagentFingerprint({ b: 2, a: 1 }), subagentFingerprint({ a: 1, b: 2 }));
	assert.match(DIGEST, /^sha256:v1:[a-f0-9]{64}$/);
	assert.throws(() => canonicalSubagentJson({ value: Number.NaN }), /non-finite/);
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.throws(() => canonicalSubagentJson(cyclic), /cyclic/);
});

test("snapshot validation accepts project and global qualified stack references", () => {
	for (const reference of ["global:worker", "project:worker"]) {
		const resolvedProfile = profile(reference);
		const stack = promptStackFixture();
		const scope = reference.split(":")[0] ?? "project";
		const candidate: AgentProfileSnapshot = {
			schemaVersion: SUBAGENT_CONTRACT_VERSION,
			profileId: `project:worker`,
			profile: resolvedProfile,
			promptStackId: reference,
			promptStack: stack,
			dependencies: [],
			profileFingerprint: subagentSourceProfileFingerprint(resolvedProfile),
			promptStackFingerprint: subagentPromptStackFingerprint(stack),
		};
		assert.deepEqual(validateAgentProfileSnapshot(candidate), [], `${reference} (scope ${scope})`);
	}
});

test("snapshot validation detects fingerprint and stack-reference drift", () => {
	const tampered = structuredClone(snapshot());
	tampered.profile.model = { provider: "test", id: "other-model" };
	assert.ok(validateAgentProfileSnapshot(tampered).some((item) => item.code === "snapshot.profile-fingerprint"));

	const wrongStack = structuredClone(snapshot());
	wrongStack.promptStack = { id: "other-stack" };
	assert.ok(validateAgentProfileSnapshot(wrongStack).some((item) => item.code === "snapshot.stack-reference"));

	const malformedProfile = structuredClone(snapshot());
	(malformedProfile.profile as { model: unknown }).model = "not-a-record";
	assert.ok(validateAgentProfileSnapshot(malformedProfile).some((item) => item.code === "snapshot.profile-model"));
});

test("request validation covers access, depth, task, media, and limit matrices", () => {
	assert.deepEqual(validateAgentRequest(request()), []);
	const imageRequest = request({
		input: { text: "", media: [{ id: "img-1", kind: "image", mimeType: "image/png", digest: DIGEST, resourceHandle: "resource-1" }] },
	});
	assert.deepEqual(validateAgentRequest(imageRequest), []);
	const mappedTask = createProtectedSubagentTask(imageRequest.input);
	const mediaPart = mappedTask.content[0];
	if (mediaPart?.type === "media") mediaPart.backendResourceId = "backend-image-1";
	assert.equal(isProtectedSubagentTaskPreserved([mappedTask], imageRequest.input), true);

	const invalid = request({
		input: { text: "" },
		access: {
			level: "read-only",
			workspaces: [{ handle: "workspace", mode: "read-write" }],
			workingDirectory: { workspaceHandle: "missing", path: "../escape" },
			network: "deny",
			executionBoundary: "isolated",
			allowProcess: true,
		},
		limits: { maxTurns: { value: 0, enforcement: "required" } },
		parent: { depth: 2, maxDepth: 2 },
	});
	const codes = validateAgentRequest(invalid).map((item) => item.code);
	for (const code of ["request.empty-task", "access.read-only-write", "access.cwd-workspace", "access.cwd-path", "access.process-level", "limits.requirement", "request.depth-limit"]) assert.ok(codes.includes(code), code);
});

test("tool negotiation intersects stack names with declared tool effects and access", () => {
	const tools: SubagentBackendTool[] = [
		{ id: "read-id", name: "read", effects: ["filesystem-read"] },
		{ id: "paint-id", name: "paint_generate", effects: ["network"] },
		{ id: "pure-id", name: "paint_validate", effects: [] },
		{ id: "write-id", name: "write", effects: ["filesystem-write"] },
	];
	const none = negotiateSubagentTools(tools, { allow: ["read", "paint_*", "missing"] }, request().access);
	assert.deepEqual(none.effectiveToolNames, ["paint_validate"]);
	assert.deepEqual(none.unmatchedAllowPatterns, ["missing"]);

	const readOnly = negotiateSubagentTools(tools, { allow: ["*"] }, {
		level: "read-only",
		workspaces: [{ handle: "workspace", mode: "read-only" }],
		network: "allow",
		executionBoundary: "isolated",
	});
	assert.deepEqual(readOnly.effectiveToolNames, ["read", "paint_generate", "paint_validate"]);
});

test("selected context budgeting preserves required items and newest optional items deterministically", () => {
	const items = [
		{ id: "old", kind: "user-excerpt" as const, text: "old optional", provenance: { source: "session" } },
		{ id: "required", kind: "summary" as const, text: "required summary", required: true, provenance: { source: "user" } },
		{ id: "new", kind: "tool-result-excerpt" as const, text: "new optional", provenance: { source: "tool", reference: "call-1" } },
	];
	const requiredAndNewBytes = Buffer.byteLength(renderSubagentSelectedContext([items[1]!, items[2]!]), "utf8");
	const budgeted = budgetSubagentContext({ maxBytes: requiredAndNewBytes, items });
	assert.deepEqual(budgeted.items.map((item) => item.id), ["required", "new"]);
	assert.deepEqual(budgeted.receipt.omittedItemIds, ["old"]);
	assert.equal(budgeted.receipt.includedBytes, requiredAndNewBytes);
	assert.match(renderSubagentSelectedContext([{ ...items[1]!, text: "<ignore>" }]), /&lt;ignore&gt;/);

	const overflow = budgetSubagentContext({ maxBytes: 10, items: [items[1]!] });
	assert.equal(hasSubagentErrors(overflow.diagnostics), true);
	assert.equal(overflow.diagnostics[0]?.code, "context.required-overflow");

	const selectedRequest = request({ selectedContext: { maxBytes: requiredAndNewBytes, items } });
	const prepared = prepareSubagentInitialMessages(selectedRequest, [{ role: "assistant", content: [{ type: "text", text: "stack" }], source: "prompt-stack" }]);
	assert.deepEqual(prepared.messages.map((message) => message.source), ["selected-context", "prompt-stack", "delegated-task"]);
	assert.equal(prepared.contextBudget?.includedBytes, requiredAndNewBytes);
	assert.equal(prepared.messages.at(-1)?.protectedTask, true);
});

test("preflight validation separates remote egress, access isolation, media, and hard limits", () => {
	const strictRequest = request({
		input: { text: "Inspect", media: [{ id: "img", kind: "image", mimeType: "image/png", digest: DIGEST, resourceHandle: "image" }] },
		limits: { timeoutMs: { value: 1_000, enforcement: "required" } },
	});
	const valid = preflight({ limits: { timeoutMs: { value: 900, enforcement: "backend-hard" } } });
	assert.deepEqual(validateBackendPreflight(valid, strictRequest, snapshot()), []);

	const remote = preflight({
		backend: { ...valid.backend, capabilities: { ...valid.backend.capabilities, remoteTransport: true, mediaMimeTypes: [] } },
		limits: { timeoutMs: { value: 1_000, enforcement: "host-abort" } },
		access: { ...valid.access, enforcement: { ...ACCESS_CAPABILITIES, agentNetworkIsolation: false } },
	});
	const codes = validateBackendPreflight(remote, strictRequest, snapshot()).map((item) => item.code);
	for (const code of ["preflight.egress", "preflight.media", "preflight.limit-enforcement", "preflight.network-isolation"]) assert.ok(codes.includes(code), code);

	const rejected = { status: "rejected", preflightId: "preflight-2", backend: valid.backend, diagnostics: [] };
	assert.equal(validateBackendPreflight(rejected).some((item) => item.code === "preflight.rejection-error"), true);
});

test("preflight accepts the complete access-level and required-limit matrices", () => {
	const accessCases: Array<{ request: AgentRequest["access"]; receipt: BackendPreflightAccepted["access"] }> = [
		{
			request: { level: "none", workspaces: [], network: "deny", executionBoundary: "isolated" },
			receipt: { level: "none", mounts: [], network: "deny", process: false, executionBoundary: "isolated", enforcement: ACCESS_CAPABILITIES },
		},
		{
			request: { level: "read-only", workspaces: [{ handle: "workspace", mode: "read-only" }], workingDirectory: { workspaceHandle: "workspace", path: "src" }, network: "deny", executionBoundary: "isolated" },
			receipt: { level: "read-only", mounts: [{ workspaceHandle: "workspace", mountId: "mount", mode: "read-only" }], workingDirectory: { mountId: "mount", path: "src" }, network: "deny", process: false, executionBoundary: "isolated", enforcement: ACCESS_CAPABILITIES },
		},
		{
			request: { level: "workspace-write", workspaces: [{ handle: "workspace", mode: "read-write" }], workingDirectory: { workspaceHandle: "workspace", path: "." }, network: "allow", allowProcess: true, executionBoundary: "isolated" },
			receipt: { level: "workspace-write", mounts: [{ workspaceHandle: "workspace", mountId: "mount", mode: "read-write" }], workingDirectory: { mountId: "mount", path: "." }, network: "allow", process: true, executionBoundary: "isolated", enforcement: ACCESS_CAPABILITIES },
		},
	];
	for (const accessCase of accessCases) {
		const req = request({ access: accessCase.request });
		assert.deepEqual(validateBackendPreflight(preflight({ access: accessCase.receipt }), req, snapshot()), [], accessCase.request.level);
	}

	for (const name of ["timeoutMs", "maxTurns", "tokenBudget", "maxOutputBytes"] as const) {
		const req = request({ limits: { [name]: { value: 20, enforcement: "required" } } });
		const candidate = preflight({ limits: { [name]: { value: 10, enforcement: "backend-hard" } } });
		assert.deepEqual(validateBackendPreflight(candidate, req, snapshot()), [], name);
	}
});

test("shared-user read-only receipts remain explicit without claiming OS isolation", () => {
	const sharedUserEnforcement: SubagentAccessCapabilities = {
		readOnlyMountIsolation: false,
		readWriteMountIsolation: false,
		symlinkSafeContainment: false,
		processIsolation: false,
		agentNetworkIsolation: false,
	};
	const access: AgentRequest["access"] = {
		level: "read-only",
		workspaces: [{ handle: "workspace", mode: "read-only" }],
		workingDirectory: { workspaceHandle: "workspace", path: "." },
		network: "allow",
		executionBoundary: "shared-user",
	};
	const receipt: BackendPreflightAccepted["access"] = {
		level: "read-only",
		mounts: [{ workspaceHandle: "workspace", mountId: "host-workspace", mode: "read-only" }],
		workingDirectory: { mountId: "host-workspace", path: "." },
		network: "allow",
		process: false,
		executionBoundary: "shared-user",
		enforcement: sharedUserEnforcement,
	};
	assert.deepEqual(validateBackendPreflight(preflight({ access: receipt }), request({ access }), snapshot()), []);

	const dishonest = structuredClone(receipt);
	dishonest.enforcement.readOnlyMountIsolation = true;
	assert.ok(validateBackendPreflight(preflight({ access: dishonest }), request({ access }), snapshot())
		.some((item) => item.code === "access-receipt.shared-user-claim"));
});

test("execution plan creation requires the protected task and carries runtime-issued fingerprints", () => {
	const req = request();
	const snap = snapshot();
	const preparedMessages = appendProtectedSubagentTask([
		{ role: "assistant", content: [{ type: "text", text: "synthetic" }], source: "prompt-stack" },
	], req.input);
	const result = createAgentExecutionPlan({
		runId: "run-1",
		request: req,
		snapshot: snap,
		preflight: preflight(),
		preparation: {
			systemPrompt: "compiled",
			messages: preparedMessages,
			toolNegotiation: { effectiveToolIds: [], effectiveToolNames: [], stackSelectedToolNames: [], unmatchedAllowPatterns: [], diagnostics: [] },
			diagnostics: [],
		},
		runtime: preparationRuntime(),
		conversationFingerprint: CONVERSATION_DIGEST,
		executionFingerprint: EXECUTION_DIGEST,
	});
	assert.equal(hasSubagentErrors(result.diagnostics), false);
	assert.equal(result.diagnostics.filter((item) => item.code === "tools.unmatched-allow").length, 2);
	assert.ok(result.plan);
	assert.equal(result.plan.conversationFingerprint, CONVERSATION_DIGEST);
	assert.equal(result.plan.executionFingerprint, EXECUTION_DIGEST);
	assert.deepEqual(validateAgentExecutionPlan(result.plan, req), []);

	// The host validates fingerprint shape and internal consistency; detecting
	// a substituted plan is the runtime's sealed-plan binding, not host-side
	// recomputation, so a tampered prompt is caught only at execution binding.
	const malformed: AgentExecutionPlan = { ...structuredClone(result.plan), executionFingerprint: "not-a-fingerprint" as never };
	assert.equal(validateAgentExecutionPlan(malformed, req).some((item) => item.code === "fingerprint.invalid"), true);

	const missingTask = createAgentExecutionPlan({
		runId: "run-2", request: req, snapshot: snap, preflight: preflight(),
		preparation: { systemPrompt: "compiled", messages: [], toolNegotiation: { effectiveToolIds: [], effectiveToolNames: [], stackSelectedToolNames: [], unmatchedAllowPatterns: [], diagnostics: [] }, diagnostics: [] },
		runtime: preparationRuntime(),
		conversationFingerprint: CONVERSATION_DIGEST,
		executionFingerprint: EXECUTION_DIGEST,
	});
	assert.equal(missingTask.plan, undefined);
	assert.equal(missingTask.diagnostics.some((item) => item.code === "plan.protected-task"), true);
	assert.deepEqual(createProtectedSubagentTask(req.input).content, preparedMessages.at(-1)?.content);
});

test("response validation enforces every terminal status matrix", () => {
	const req = request({ limits: {
		timeoutMs: { value: 1_000, enforcement: "best-effort" },
		maxTurns: { value: 5, enforcement: "required" },
	} });
	const planResult = createAgentExecutionPlan({
		runId: "run-response", request: req, snapshot: snapshot(), preflight: preflight({ limits: {
			timeoutMs: { value: 1_000, enforcement: "host-abort" },
			maxTurns: { value: 5, enforcement: "backend-hard" },
		} }),
		preparation: { systemPrompt: "system", messages: appendProtectedSubagentTask([], req.input), toolNegotiation: { effectiveToolIds: [], effectiveToolNames: [], stackSelectedToolNames: [], unmatchedAllowPatterns: [], diagnostics: [] }, diagnostics: [] },
		runtime: preparationRuntime(),
		conversationFingerprint: CONVERSATION_DIGEST,
		executionFingerprint: EXECUTION_DIGEST,
	});
	const plan = planResult.plan!;
	const common = {
		schemaVersion: 1 as const,
		requestId: req.requestId,
		runId: plan.runId,
		backendId: plan.backendId,
		profileFingerprint: plan.profile.profileFingerprint,
		executionFingerprint: plan.executionFingerprint,
		model: plan.model,
		effectiveToolIds: [],
		enforcement: { access: plan.access, limits: plan.limits },
		durationMs: 10,
		artifacts: [],
	};
	const responses: AgentResponse[] = [
		{ ...common, status: "completed", output: { text: "done", partial: false } },
		{ ...common, status: "failed", error: { code: "provider", message: "failed" }, output: { text: "partial", partial: true } },
		{ ...common, status: "cancelled", reason: "user" },
		{ ...common, status: "timed-out", reason: "deadline", enforcedTimeoutMs: 1_000 },
		{ ...common, status: "limit-reached", reachedLimit: "maxTurns" },
	];
	for (const response of responses) assert.deepEqual(validateAgentResponse(response, { request: req, plan }), [], response.status);

	const invalid = [
		{ ...responses[0], output: { text: "bad", partial: true } },
		{ ...common, status: "failed" },
		{ ...common, status: "cancelled", reason: "", error: { code: "wrong", message: "wrong field" } },
		{ ...common, status: "timed-out", reason: "deadline" },
		{ ...common, status: "limit-reached", reachedLimit: "unknown" },
	];
	for (const response of invalid) assert.equal(hasSubagentErrors(validateAgentResponse(response)), true);
});

test("artifact and trace references enforce normalized namespaces, paths, and expiry", () => {
	assert.deepEqual(validateSubagentArtifactReference({
		id: "artifact-1", workspaceNamespace: "workspace.main", path: "reports/result.md",
		authorization: "read", lifetime: "run", cleanup: "backend",
	}), []);
	assert.equal(hasSubagentErrors(validateSubagentArtifactReference({
		id: "artifact", workspaceNamespace: "bad namespace", path: "../secret",
		authorization: "owner", lifetime: "forever", cleanup: "nobody",
	})), true);
	assert.deepEqual(validateSubagentTraceReference({
		handle: "trace-1", backendId: "backend", authorizationScope: "session.main", expiresAt: "2026-07-12T12:00:00.000Z",
	}), []);
	assert.equal(hasSubagentErrors(validateSubagentTraceReference({ handle: "trace", backendId: "backend", authorizationScope: "bad scope", expiresAt: "tomorrow" })), true);
});

test("public validators diagnose malformed unknown values without throwing", () => {
	const malformedValues: Array<() => unknown> = [
		() => validateAgentRequest({}),
		() => validateAgentProfileSnapshot({ schemaVersion: 1, profile: {}, promptStack: null, dependencies: [] }),
		() => validateBackendPreflight({ status: "accepted", preflightId: "x", backend: {}, model: {}, thinkingLevel: 1, toolCatalog: [], access: {}, limits: {}, diagnostics: [] }, request()),
		() => validateAgentExecutionPlan({ schemaVersion: 1, messages: [null] }, request()),
		() => validateAgentResponse({ status: "completed", artifacts: [null] }),
	];
	for (const validate of malformedValues) {
		assert.doesNotThrow(validate);
		assert.equal(hasSubagentErrors(validate() as ReturnType<typeof validateAgentRequest>), true);
	}
});
