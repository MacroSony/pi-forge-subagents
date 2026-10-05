import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DeterministicFakeBackend } from "@zihanw/pi-subagent-runtime/testing";
import type { ForgePrepareRequest } from "@zihanw/pi-forge/subagent";
import { negotiateSubagentTools, subagentSourceProfileFingerprint, validateAgentExecutionPlan, type AgentProfileSnapshot } from "../src/contract/index.ts";
import { createForgeSubagentRuntime, type ForgeSubagentPreparedRun } from "../src/runtime/subagent-runtime.ts";
import { createPublicHandleAllocator } from "../src/runtime/public-handles.ts";
import type { ForgeHostSession } from "../src/host/session.ts";

const PROVIDER = "forge-overrides-fixture";
const model = { provider: PROVIDER, id: "base" };
const overrideModel = { provider: PROVIDER, id: "alternate" };
const task = "Do the fixture task.";

function fixture(backendId = "fake") {
	const cwd = mkdtempSync(join(tmpdir(), "forge-overrides-"));
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	const snapshot: AgentProfileSnapshot = {
		schemaVersion: 1, profileId: "project:worker",
		profile: { schemaVersion: 1, type: "pi-forge.agent-profile", id: "worker", model, thinkingLevel: "medium", promptStack: null },
		promptStackId: null, promptStack: null, dependencies: [],
		profileFingerprint: `sha256:v1:${"0".repeat(64)}`, promptStackFingerprint: null,
	};
	snapshot.profileFingerprint = subagentSourceProfileFingerprint(snapshot.profile);
	const requests: ForgePrepareRequest[] = [];
	let onResolve: (() => Promise<void>) | undefined;
	let onCompile: (() => Promise<void>) | undefined;
	const session = {
		resolveProfile: async () => { await onResolve?.(); return { snapshot }; },
		prepare: async (request: ForgePrepareRequest) => {
			requests.push(request);
			await onCompile?.();
			const tools = negotiateSubagentTools(request.backend.toolCatalog as never, undefined, request.access as never);
			return {
				profileId: snapshot.profileId, model: request.backend.model, thinkingLevel: request.backend.thinkingLevel,
				systemPrompt: "You are a fixture worker.",
				messages: [{ role: "user", content: [{ type: "text", text: request.task.text }], protectedTask: true, source: "delegated-task" }],
				effectiveToolIds: tools.effectiveToolIds, effectiveToolNames: tools.effectiveToolNames,
				diagnostics: tools.diagnostics, profileSnapshot: snapshot, preparedAt: "2026-10-04T00:00:00Z",
			};
		},
	} as unknown as ForgeHostSession;
	let trusted = true;
	const ctx: any = { cwd, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => "owner" }, modelRegistry: {} };
	const config = (allow = false, profileAllow?: boolean) => writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
		allowAgentInvocationWithoutApproval: true, allowAgentModelOverrides: allow,
		profiles: { "project:worker": { enabled: true, backend: backendId, ...(profileAllow === undefined ? {} : { allowAgentModelOverrides: profileAllow }) } },
	}));
	config();
	return { ctx, cwd, session, snapshot, requests, config,
		setTrusted: (value: boolean) => { trusted = value; },
		setResolve: (fn?: () => Promise<void>) => { onResolve = fn; },
		setCompile: (fn?: () => Promise<void>) => { onCompile = fn; },
		cleanup: () => rmSync(cwd, { recursive: true, force: true }),
	};
}

function ready(result: Awaited<ReturnType<ReturnType<typeof createForgeSubagentRuntime>["prepare"]>>): ForgeSubagentPreparedRun {
	assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.diagnostics));
	if (!result.ok) throw new Error("Preparation failed");
	return result.prepared;
}

function gate() {
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => { release = resolve; });
	const entry = new Promise<void>((resolve) => { entered = resolve; });
	return { entry, release, wait: async () => { entered(); await waiting; } };
}

function fakeRuntime(f: ReturnType<typeof fixture>) {
	const backend = new DeterministicFakeBackend({ id: "fake", fidelity: "backend-assisted", cancelSettles: true });
	const taken: string[] = [];
	const report = { fixture: true };
	(backend as any).takeReport = (id: string) => { taken.push(id); return report; };
	const runtime = createForgeSubagentRuntime(() => f.session, { builtInBackends: false, extraBackends: [backend],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});
	return { backend, runtime, taken, report };
}

test("public handle allocator has lifetime counters and distinct reload namespaces", () => {
	const alloc = createPublicHandleAllocator();
	assert.match(alloc("t"), /^t-[a-z0-9]{6}-1$/);
	assert.match(alloc("c"), /^c-[a-z0-9]{6}-2$/);
	const ids = new Set(Array.from({ length: 100 }, () => createPublicHandleAllocator()("t")));
	assert.equal(ids.size, 100);
});

test("override opt-in respects profile policy, preserves snapshot, and maps public task/report IDs", async () => {
	const f = fixture();
	const { runtime, backend, taken, report } = fakeRuntime(f);
	try {
		for (const overrides of [{ model: overrideModel }, { thinkingLevel: "high" }, { model, thinkingLevel: "medium" }]) {
			const denied = await runtime.prepare("worker", task, f.ctx, { unattended: true, ...overrides });
			assert.equal(denied.ok, false);
		}
		assert.equal(backend.preflightCalls.length, 0);
		const defaultPlan = ready(await runtime.prepare("worker", task, f.ctx));
		assert.deepEqual(defaultPlan.plan.model, model);
		assert.equal(defaultPlan.plan.thinkingLevel, "medium");
		await runtime.discard(defaultPlan);
		f.config(true, false);
		assert.equal((await runtime.prepare("worker", task, f.ctx, { model: overrideModel })).ok, false);
		f.config(false, true);
		const prepared = ready(await runtime.prepare("worker", task, f.ctx, { model: overrideModel, thinkingLevel: "high" }));
		assert.match(prepared.plan.runId, /^t-[a-z0-9]{6}-\d+$/);
		assert.equal(prepared.plan.thinkingLevel, "high");
		assert.deepEqual(prepared.plan.model, overrideModel);
		assert.deepEqual(prepared.plan.profile, f.snapshot);
		assert.deepEqual(f.requests.at(-1)?.backend.model, overrideModel);
		assert.equal(f.requests.at(-1)?.backend.thinkingLevel, "high");
		assert.equal(validateAgentExecutionPlan(prepared.plan, prepared.request).filter((d) => d.level === "error").length, 0);
		const handle = await runtime.start!(prepared, f.ctx);
		const response = await handle.result;
		assert.equal(response.runId, prepared.plan.runId);
		assert.equal(handle.id, prepared.plan.runId);
		assert.notEqual(backend.startCalls[0].preparedRunId, handle.id);
		assert.deepEqual(runtime.takeReport!(handle.id), report);
		assert.deepEqual(taken, [backend.startCalls[0].preparedRunId]);
		assert.equal(runtime.takeReport!(handle.id), undefined);
		const oldId = handle.id;
		await runtime.dispose();
		const afterDispose = ready(await runtime.prepare("worker", task, f.ctx));
		assert.notEqual(afterDispose.plan.runId, oldId);
		const reloaded = fakeRuntime(f).runtime;
		try {
			assert.notEqual(ready(await reloaded.prepare("worker", task, f.ctx)).plan.runId, oldId);
			assert.equal(reloaded.takeReport!(oldId), undefined);
		} finally { await reloaded.dispose(); }
	} finally { await runtime.dispose(); f.cleanup(); }
});

test("trusted attended overrides remain available without unattended opt-in", async () => {
	const f = fixture();
	const { runtime } = fakeRuntime(f);
	try {
		ready(await runtime.prepare("worker", task, f.ctx, { unattended: false, model: overrideModel, thinkingLevel: "low" }));
		f.setTrusted(false);
		assert.equal((await runtime.prepare("worker", task, f.ctx, { unattended: false, model: overrideModel })).ok, false);
	} finally { await runtime.dispose(); f.cleanup(); }
});

test("prepare and final start recheck override permission across awaited authorization/compile", async (t) => {
	for (const boundary of ["resolve", "compile", "backend", "start"] as const) await t.test(boundary, async () => {
		const f = fixture();
		f.config(true);
		const { runtime, backend } = fakeRuntime(f);
		const g = gate();
		try {
			if (boundary === "start") {
				const prepared = ready(await runtime.prepare("worker", task, f.ctx, { thinkingLevel: "high" }));
				f.setResolve(g.wait);
				const starting = runtime.start!(prepared, f.ctx);
				await g.entry;
				f.config(false);
				g.release();
				await assert.rejects(starting, /overrides.*revoked/);
				await runtime.discard(prepared);
			} else {
				if (boundary === "resolve") f.setResolve(g.wait);
				else if (boundary === "compile") f.setCompile(g.wait);
				else {
					const prepareBackend = backend.prepare.bind(backend);
					backend.prepare = async (input, context) => {
						const prepared = await prepareBackend(input, context);
						await g.wait();
						return prepared;
					};
				}
				const preparing = runtime.prepare("worker", task, f.ctx, { model: overrideModel, thinkingLevel: "high" });
				await g.entry;
				f.config(false);
				g.release();
				assert.equal((await preparing).ok, false);
			}
			assert.equal(backend.startCalls.length, 0);
			if (boundary === "backend") assert.equal(backend.discardCalls.length, 1);
		} finally { g.release(); await runtime.dispose(); f.cleanup(); }
	});
});

test("cancel race preserves public ID and execution cleanup", async () => {
	const f = fixture();
	const { runtime, backend } = fakeRuntime(f);
	backend.executionMode = "delayed";
	try {
		const prepared = ready(await runtime.prepare("worker", task, f.ctx));
		const abort = new AbortController();
		abort.abort("fixture cancel");
		const handle = await runtime.start!(prepared, f.ctx, abort.signal);
		const result = await handle.result;
		assert.equal(result.status, "cancelled");
		assert.equal(result.runId, prepared.plan.runId);
		assert.equal(handle.id, result.runId);
		assert.equal(backend.startCalls.length, 0);
		assert.equal(backend.discardCalls.length, 1, "pre-start cancellation discards the preparation");
		const activePlan = ready(await runtime.prepare("worker", task, f.ctx));
		const activeAbort = new AbortController();
		const active = await runtime.start!(activePlan, f.ctx, activeAbort.signal);
		await backend.waitForStart();
		activeAbort.abort("active cancel");
		assert.equal((await active.result).runId, activePlan.plan.runId);
		assert.equal(backend.executionDisposeCalls.length, 1);
	} finally { await runtime.dispose(); f.cleanup(); }
});

test("real SDK strict overrides and retained child public mapping, ownership, serial reservation and release retry", async () => {
	const f = fixture("pi-inprocess");
	f.config(true);
	const faux = createFauxCore({ api: "forge-overrides-api", provider: PROVIDER,
		models: [{ id: "base", reasoning: true }, { id: "alternate", reasoning: true }, { id: "no-thinking", reasoning: false }] });
	faux.setResponses(Array.from({ length: 8 }, () => () => fauxAssistantMessage("fixture answer")));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(PROVIDER, {
		api: "forge-overrides-api", baseUrl: "https://fixture.invalid", apiKey: "fixture",
		streamSimple: (m, context, options) => faux.streamSimple(m, context, options),
		models: ["base", "alternate", "no-thinking"].map((id) => ({
			id, name: id, reasoning: id !== "no-thinking", input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000,
		})),
	});
	f.ctx.modelRegistry = new ModelRegistry(modelRuntime);
	const runtime = createForgeSubagentRuntime(() => f.session);
	try {
		for (const overrides of [
			{ model: { provider: PROVIDER, id: "missing" } },
			{ thinkingLevel: "nonsense" },
			{ model: { provider: PROVIDER, id: "no-thinking" }, thinkingLevel: "high" },
			{ thinkingLevel: "xhigh" },
		]) {
			const rejected = await runtime.prepare("worker", task, f.ctx, overrides);
			assert.equal(rejected.ok, false, JSON.stringify(overrides));
		}
		assert.equal(f.requests.length, 0, "strict rejection happens before Forge compilation");
		const first = ready(await runtime.prepare("worker", task, f.ctx, { model: overrideModel, thinkingLevel: "high", keepContext: true }));
		const firstResponse = await runtime.execute(first, f.ctx);
		assert.equal(firstResponse.status, "completed", JSON.stringify(firstResponse));
		const id = firstResponse.continuationId!;
		assert.match(id, /^c-[a-z0-9]{6}-\d+$/);
		assert.equal(firstResponse.runId, first.plan.runId);
		const expected = { id, profileId: "project:worker", backendId: "pi-inprocess", cwd: realpathSync(f.cwd), model: overrideModel, thinkingLevel: "high" };
		assert.deepEqual(runtime.listContinuations!(f.ctx), [expected]);
		const summary = runtime.listContinuations!(f.ctx)[0];
		summary.model.id = "mutated";
		assert.deepEqual(runtime.listContinuations!(f.ctx), [expected]);
		assert.deepEqual(runtime.listContinuations!({ ...f.ctx, sessionManager: { getSessionId: () => "stranger" } }), []);
		assert.deepEqual(runtime.listContinuations!({ ...f.ctx, cwd: tmpdir() }), []);
		assert.equal(runtime.continuationInfo!(id, f.ctx)?.thinkingLevel, "high");
		const siblingCwd = join(f.cwd, "sibling");
		mkdirSync(siblingCwd);
		const siblingPlan = ready(await runtime.prepare("worker", task, f.ctx, { cwd: siblingCwd, unattended: false, keepContext: true }));
		const siblingResponse = await runtime.execute(siblingPlan, f.ctx);
		assert.equal(siblingResponse.status, "completed");
		assert.notEqual(siblingResponse.continuationId, id);
		assert.equal(runtime.listContinuations!(f.ctx).length, 2, "target generations do not evict each other's retained children");
		assert.equal(runtime.continuationInfo!(siblingResponse.continuationId!, f.ctx)?.cwd, realpathSync(siblingCwd));
		await runtime.releaseContinuation!(siblingResponse.continuationId!, f.ctx);
		assert.deepEqual(runtime.listContinuations!(f.ctx), [expected]);
		for (const changed of [{ model }, { thinkingLevel: "low" }]) {
			assert.equal((await runtime.prepare("worker", task, f.ctx, { continueId: id, ...changed })).ok, false);
		}
		f.config(false);
		assert.equal((await runtime.prepare("worker", task, f.ctx, { continueId: id })).ok, false);
		f.config(true);
		const next = ready(await runtime.prepare("worker", task, f.ctx, { continueId: id }));
		assert.deepEqual(next.plan.model, overrideModel);
		assert.equal(next.plan.thinkingLevel, "high");
		assert.deepEqual(next.plan.profile, f.snapshot);
		f.config(false);
		await assert.rejects(runtime.start!(next, f.ctx), /overrides.*revoked/);
		f.config(true);
		const serial = await runtime.prepare("worker", task, f.ctx, { continueId: id });
		assert.equal(serial.ok, false, "retained child is serially reserved");
		if (!serial.ok) assert.doesNotMatch(JSON.stringify(serial.diagnostics), /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
		await assert.rejects(runtime.releaseContinuation!(id, f.ctx), (error: Error) => {
			assert.doesNotMatch(error.message, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
			return /busy|reserved|active|prepared/i.test(error.message);
		});
		assert.equal(runtime.listContinuations!(f.ctx).length, 1, "failed release remains retryable");
		const nextResponse = await runtime.execute(next, f.ctx);
		assert.equal(nextResponse.continuationId, id, "one stable public child ID across turns");
		assert.equal(nextResponse.status, "completed");
		const otherBranchCtx = { ...f.ctx, sessionManager: { getSessionId: () => "owner", getLeafId: () => "other-branch", getBranch: () => [] } };
		assert.equal(runtime.listContinuations!(otherBranchCtx)[0].id, id, "contexts are explicitly session-wide, not a branch secrecy boundary");
		const sharedTurn = ready(await runtime.prepare("worker", task, otherBranchCtx, { continueId: id }));
		await runtime.discard(sharedTurn);
		await runtime.releaseContinuation!(id, f.ctx);
		assert.deepEqual(runtime.listContinuations!(f.ctx), []);
		assert.equal(runtime.continuationInfo!(id, f.ctx), undefined);
		const profileChild = ready(await runtime.prepare("worker", task, f.ctx, { keepContext: true }));
		const profileResponse = await runtime.execute(profileChild, f.ctx);
		f.config(false);
		const profileTurn = ready(await runtime.prepare("worker", task, f.ctx, { continueId: profileResponse.continuationId }));
		await runtime.discard(profileTurn);
		const priorId = profileResponse.continuationId!;
		await runtime.dispose();
		assert.deepEqual(runtime.listContinuations!(f.ctx), []);
		assert.equal((await runtime.prepare("worker", task, f.ctx, { continueId: priorId })).ok, false);
		const reload = createForgeSubagentRuntime(() => f.session);
		try {
			const reloadedPlan = ready(await reload.prepare("worker", task, f.ctx, { keepContext: true }));
			const response = await reload.execute(reloadedPlan, f.ctx);
			assert.notEqual(response.continuationId, priorId);
			assert.notEqual(response.runId, firstResponse.runId);
		} finally { await reload.dispose(); }
	} finally { await runtime.dispose(); f.ctx.modelRegistry.unregisterProvider(PROVIDER); f.cleanup(); }
});
