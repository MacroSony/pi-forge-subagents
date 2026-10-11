import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";
import { getSubagentUsageReceipts, registerForgeSubagentUsageBridge } from "../src/usage/receipts.ts";

const U = { tokens: { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, total: 25 }, requests: { total: 1, cacheKnown: 1, usageKnown: 1 }, cost: { amount: 0.037, currency: "USD", breakdown: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004 } } };
const native = { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, totalTokens: 25, cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 } };
const otherUsage = { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 } };
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const subCall = `tools.forge_subagent({profileId:"project:worker",task:"PRIVATE TASK",backend:"test"})`;

async function runScript(code: string, options: { bridge?: boolean; tool?: string; statuses?: string[]; partial?: boolean; cancelPending?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "forge-receipt-sdk-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({ allowAgentInvocationWithoutApproval: true, profiles: { "project:worker": { enabled: true, backend: "test" } } }));
	const provider = "forge-receipt-sdk-faux"; const api = "forge-receipt-sdk-faux-api"; const modelId = "selected-not-physical";
	const faux = createFauxCore({ api, provider, models: [{ id: modelId }] });
	const toolName = options.tool ?? "codemode";
	faux.setResponses([fauxAssistantMessage(fauxToolCall(toolName, toolName === "codemode" ? { code } : {}, { id: "root" })), fauxAssistantMessage("controller done")]);
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	modelRuntime.registerProvider(provider, { api, baseUrl: "https://faux.invalid", apiKey: "synthetic", models: [{ id: modelId, name: "synthetic", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 4000 }], streamSimple: (model: any, context: any, opts: any) => {
		const source = faux.streamSimple(model, context, opts); const target = createAssistantMessageEventStream();
		void (async () => { for await (const event of source) { if (event.type === "done") { const message = { ...event.message, usage: structuredClone(zeroUsage) }; target.push({ type: "done", reason: event.reason, message }); target.end(message); return; } target.push(event); } })();
		return target;
	} });
	let seq = 0; let preparedSeq = 0; let cancelled = 0; let disposed: (() => void) | undefined;
	let startedResolve!: () => void; const started = new Promise<void>((resolve) => { startedResolve = resolve; });
	const statuses = options.statuses ?? ["completed"];
	const usage = options.partial ? { tokens: { input: 11, output: 7, total: 18 }, requests: { total: 2, cacheKnown: 0, usageKnown: 0 }, cost: { amount: 0.037, currency: "USD" } } : U;
	const runtime: any = {
		backendIds: () => ["test"], descriptors: () => [],
		prepare: async () => ({ ok: true, prepared: { id: `task${++preparedSeq}`, plan: { profile: { profileId: "project:worker", promptStackId: null, profile: { thinkingLevel: "off" } }, backendId: "test", model: { provider, id: modelId }, systemPrompt: "synthetic", messages: [], effectiveToolIds: ["read"], access: { level: "read-only", executionBoundary: "shared-user", mounts: [] }, executionFingerprint: "fp", conversationFingerprint: "cp" }, diagnostics: [] } }),
		discard: async () => {},
		execute: async (_prepared: any, _ctx: any, signal: AbortSignal, update: any) => {
			const n = ++seq; update?.({ phase: "message", message: "PRIVATE PROGRESS" });
			if (options.cancelPending && n === 2) {
				startedResolve();
				await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
				cancelled++;
			}
			return { runId: `response-${n}`, model: { provider, id: modelId }, status: options.cancelPending && n === 2 ? "cancelled" : statuses[(n - 1) % statuses.length], usage: structuredClone(usage), output: { text: "PRIVATE OUTPUT", partial: options.partial ?? (options.cancelPending && n === 2) }, error: { code: "faux", message: "scripted failure" }, reason: "scripted cancellation", continuationId: "same-retained-handle" };
		},
		dispose: async () => {},
	};
	const toolEvents: any[] = []; const extensionErrors: any[] = [];
	const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	const loader = new DefaultResourceLoader({ cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Scripted synthetic controller", extensionFactories: [createCodemodeExtension({ models: false }), (pi) => {
		registerForgeSubagentTool(pi, runtime, { sessionProvider: () => ({}) as any });
		pi.registerTool({ name: "other_usage", label: "Other", description: "Other-tool synthetic usage", parameters: Type.Object({}), executionMode: "parallel", outputSchema: Type.Object({ untouched: Type.Boolean() }), execute: async () => ({ content: [{ type: "text", text: "OTHER OUTPUT" }], structuredContent: { untouched: true }, details: { unrelated: true }, usage: structuredClone(otherUsage) }) });
		pi.registerTool({ name: "recursive", label: "Recursive", description: "Recursive native pipeline fixture", parameters: Type.Object({}), executionMode: "parallel", execute: async (_id, _params, signal, _update, ctx) => { const result = await ctx.executeTool("forge_subagent", { profileId: "project:worker", task: "PRIVATE TASK", backend: "test" }, { signal }); return { content: result.result.content, details: { wrapper: true } }; } });
		pi.registerTool({ name: "forward_nested", label: "Forward nested", description: "Forwards child standard usage but not its model envelope", parameters: Type.Object({}), executionMode: "parallel", execute: async (_id, _params, signal, _update, ctx) => { const outcome = await ctx.executeTool("forge_subagent", { profileId: "project:worker", task: "PRIVATE TASK", backend: "test" }, { signal }); const details = outcome.result.details as any; return { content: outcome.result.content, details: { wrapper: true, forgeNestedUsage: details.forgeNestedUsage } }; } });
		pi.registerTool({ name: "deep_wrapper", label: "Deep wrapper", description: "Recursive tool-call pipeline fixture", parameters: Type.Object({}), executionMode: "parallel", execute: async (_id, _params, signal, _update, ctx) => { const result = await ctx.executeTool("recursive", {}, { signal }); return { content: result.result.content, details: { outer: true } }; } });
		pi.registerTool({ name: "wait_started", label: "Barrier", description: "Deterministic scripted cancellation barrier", parameters: Type.Object({}), executionMode: "parallel", execute: async () => { await started; return { content: [{ type: "text", text: "started" }], details: {} }; } });
		const before = new Map<string, any>();
		pi.on("tool_result", (event) => { before.set(event.toolCallId, { content: event.content, structuredContent: event.structuredContent, usage: event.usage, isError: event.isError }); });
		if (options.bridge !== false) disposed = registerForgeSubagentUsageBridge(pi);
		pi.on("tool_result", (event) => {
			const original = before.get(event.toolCallId);
			for (const key of ["content", "structuredContent", "usage", "isError"] as const) assert.strictEqual(event[key], original[key], `bridge preserves exact ${key} on ${event.toolName}`);
			toolEvents.push(structuredClone(event));
		});
	} ] });
	await loader.reload();
	let session: any;
	try {
		const created = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), thinkingLevel: "off", resourceLoader: loader, sessionManager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), tools: [toolName, "forge_subagent", "recursive", "forward_nested", "deep_wrapper", "other_usage", "wait_started", "codemode"] });
		session = created.session; session.subscribe((event: any) => { if (event.type === "extension_error") extensionErrors.push(event); });
		await session.prompt("Execute the scripted controller."); await session.waitForIdle();
		assert.equal(faux.state.callCount, 2); assert.equal(extensionErrors.length, 0);
		const entries = sessionManager.getBranch(); const results = entries.filter((e: any) => e.type === "message" && e.message.role === "toolResult");
		assert.equal(results.length, 1, "only the model-issued wrapper persists");
		const message = (results[0] as any).message;
		const file = sessionManager.getSessionFile()!;
		const reopened = SessionManager.open(file).getBranch();
		assert.deepEqual(reopened, JSON.parse(JSON.stringify(entries)), "JSONL reopen preserves every serializable field (undefined is omitted by JSON)");
		const summarize = (await import(new URL("./session-usage.js", import.meta.resolve("@zihanw/pi-forge")).href)).summarizeSessionCacheUsage;
		return { message, receipts: getSubagentUsageReceipts(reopened), summary: summarize(reopened), stats: session.getSessionStats(), toolEvents, cancelled, jsonl: readFileSync(file, "utf8") };
	} finally { disposed?.(); session?.dispose(); await runtime.dispose(); modelRuntime.unregisterProvider(provider); rmSync(cwd, { recursive: true, force: true }); }
}

function assertSubagentTotals(result: any, n: number, partial = false) {
	assert.equal(result.receipts.length, n, JSON.stringify(result.message));
	assert.equal(result.message.details.forgeNestedUsage.requests, (partial ? 2 : 1) * n);
	assert.equal(result.message.details.forgeNestedUsage.input, 11 * n);
	// Forge 0.5.8's cache panel explicitly excludes cache-unknown calls from numeric totals.
	assert.equal(result.summary.nested.session.requests, partial ? 0 : n);
	assert.equal(result.summary.nested.session.input, partial ? 0 : 11 * n); assert.equal(result.summary.nested.session.output, partial ? 0 : 7 * n);
	assert.equal(result.summary.nested.session.cacheUnknownCalls, partial ? 1 : 0);
	assert.doesNotMatch(JSON.stringify(result.message.details.forgeSubagentUsage), /PRIVATE|same-retained|physicalRoute/);
	assert.deepEqual(getSubagentUsageReceipts([{ type: "message", message: result.message }, { type: "message", message: result.message }]), result.receipts);
}

test("real SDK codemode + JSONL reopen restores Forge nested totals without changing native usage", async () => {
	const code = `text(await ${subCall});`;
	const baseline = await runScript(code, { bridge: false }); const bridged = await runScript(code);
	assert.equal(baseline.summary.nested.session.calls, 0, "reproduce codemode detail loss");
	assertSubagentTotals(bridged, 1); assert.deepEqual(bridged.message.usage, native);
	for (const key of ["structuredContent", "isError", "usage"]) assert.deepEqual(bridged.message[key], baseline.message[key]);
	assert.deepEqual(bridged.stats.tokens, baseline.stats.tokens); assert.equal(bridged.stats.cost, baseline.stats.cost); assert.deepEqual(bridged.summary.main, baseline.summary.main);
});

test("real SDK genuine codemode recursively carries receipts through two wrapper levels", async () => {
	const result = await runScript(`text(await tools.deep_wrapper({}));`);
	assertSubagentTotals(result, 1); assert.deepEqual(result.message.usage, native);
	assert.ok(result.toolEvents.some((e: any) => e.toolName === "forge_subagent" && e.parentToolCallId === "root/1/1"));
});

test("real SDK nested recursive fixture dedupes once and never copies native usage", async () => {
	const result = await runScript(`text(await tools.recursive({}));`);
	assertSubagentTotals(result, 1); assert.deepEqual(result.message.usage, native);
	assert.ok(result.toolEvents.some((e: any) => e.parentToolCallId === "root/1"));
});

test("real SDK parallel subagents plus other-tool usage keeps attribution separate", async () => {
	const code = `const r = await Promise.all([${subCall}, tools.recursive({}), tools.other_usage({})]); text(r);`;
	const baseline = await runScript(code, { bridge: false }); const result = await runScript(code);
	assertSubagentTotals(result, 2);
	assert.deepEqual(result.message.usage, baseline.message.usage); assert.deepEqual(result.stats.tokens, baseline.stats.tokens); assert.equal(result.stats.cost, baseline.stats.cost);
	assert.deepEqual(result.stats.tokens, { input: 24, output: 17, cacheRead: 11, cacheWrite: 4, total: 56 });
	const other = result.toolEvents.find((e: any) => e.toolName === "other_usage"); assert.deepEqual(other.structuredContent, { untouched: true }); assert.equal(other.details.forgeSubagentUsage, undefined);
	assert.ok(Math.abs(result.stats.cost - (0.037 * 2 + 0.02)) < 1e-12);
});

test("real SDK failed codemode preserves already consumed partial subagent usage", async () => {
	const code = `text(await ${subCall}); throw new Error("scripted after usage");`;
	const baseline = await runScript(code, { bridge: false, statuses: ["failed"], partial: true }); const result = await runScript(code, { statuses: ["failed"], partial: true });
	assertSubagentTotals(result, 1, true); assert.equal(result.receipts[0].status, "failed");
	assert.equal(result.message.isError, true); assert.match(JSON.stringify(result.message.content), /scripted after usage/);
	for (const key of ["structuredContent", "isError", "usage"]) assert.deepEqual(result.message[key], baseline.message[key]);
});

test("real SDK cancelled child response keeps partial unknown-cache usage; no native fabrication", async () => {
	const result = await runScript(`text(await ${subCall});`, { statuses: ["cancelled"], partial: true });
	assertSubagentTotals(result, 1, true); assert.equal(result.receipts[0].status, "cancelled"); assert.equal(result.message.usage, undefined); assert.equal(result.stats.cost, 0);
});

test("real SDK codemode cancels an unfinished call after usage; actual AbortSignal delta survives", { timeout: 15000 }, async () => {
	const code = `text(await ${subCall}); const pending = ${subCall}; await tools.wait_started({}); return "exit with pending call";`;
	const baseline = await runScript(code, { bridge: false, cancelPending: true });
	const result = await runScript(code, { cancelPending: true });
	assert.equal(result.cancelled, 1, "codemode actually aborted the pending subagent signal");
	assertSubagentTotals(result, 2); assert.deepEqual(result.receipts.map((r) => r.status), ["completed", "cancelled"]);
	assert.deepEqual(result.message.usage, baseline.message.usage); assert.deepEqual(result.stats.tokens, baseline.stats.tokens); assert.equal(result.stats.cost, baseline.stats.cost);
});

test("C5 real SDK forwarding wrapper preserves exactly one request in Forge and native JSONL totals", async () => {
	const result = await runScript(`text(await tools.forward_nested({}));`);
	assertSubagentTotals(result, 1); assert.deepEqual(result.message.usage, native);
	assert.equal(result.stats.cost, 0.037); assert.deepEqual(result.stats.tokens, { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, total: 25 });
	const wrapper = result.toolEvents.find((e: any) => e.toolName === "forward_nested");
	assert.equal(wrapper.details.forgeNestedUsage.requests, 1); assert.equal(wrapper.details.forgeSubagentUsage.runs.length, 1);
});

test("C5 real SDK directly persisted forwarding wrapper does not double the Forge summarizer", async () => {
	const result = await runScript("", { tool: "forward_nested" });
	assertSubagentTotals(result, 1); assert.deepEqual(result.message.usage, native);
	assert.equal(result.summary.nested.session.calls, 1);
});
