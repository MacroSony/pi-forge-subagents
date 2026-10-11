import assert from "node:assert/strict";
import test from "node:test";
import { getSubagentUsageReceipts, registerForgeSubagentUsageBridge } from "../src/usage/receipts.ts";
import { mapForgeSubagentUsage } from "../src/tool/forge-subagent-usage.ts";
const usage = { tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, total: 33 }, requests: { total: 1, cacheKnown: 1, usageKnown: 1 }, cost: { amount: 0.5, currency: "USD", breakdown: { input: 0.2, output: 0.2, cacheRead: 0.1, cacheWrite: 0 } } };
function child(runId = "response-1", taskId = "t-same-namespace-1", u: any = usage): any {
	return { toolCallId: "root/1", parentToolCallId: "root", toolName: "forge_subagent", content: [{ type: "text", text: "unchanged" }], structuredContent: { keep: true }, isError: false, usage: mapForgeSubagentUsage(u).native, details: { runId: taskId, usageCredited: true, response: { runId, model: { provider: "selected", id: "model" }, status: "completed", usage: u } } };
}
const entry = (m: any) => ({ type: "message", message: { ...m, role: "toolResult" } });
const root = (details: any = {}): any => ({ toolCallId: "root", toolName: "wrapper", details, content: [{ type: "text", text: "root" }], usage: { original: true }, isError: false });
function harness() {
	let sessionId = "old"; const handlers = new Map<string, any>();
	const dispose = registerForgeSubagentUsageBridge({ on: (name: string, fn: any) => { handlers.set(name, fn); return () => handlers.delete(name); } } as any);
	const fire = (name: string, event: any = {}) => handlers.get(name)?.(event, { sessionManager: { getSessionId: () => sessionId } });
	const apply = (event: any) => ({ ...event, ...fire("tool_result", event) });
	return { fire, apply, dispose, switch: () => { sessionId = "new"; fire("session_start"); } };
}

test("C1 canonical same-namespace counters and complete UUID metadata never collapse", () => {
	const a = child(); const b = child("response-2", "t-same-namespace-2"); b.toolCallId = "root/2";
	const uuid = "prepared:aaaaaaaa-1111-2222-3333-444444444444";
	const c = child("response-3", uuid); c.toolCallId = "root/3";
	const h = harness(); h.apply(a); h.apply(b); h.apply(c);
	const runs = getSubagentUsageReceipts([entry(h.apply(root()))]);
	assert.deepEqual(runs.map((r) => r.taskId), ["t-same-namespace-1", "t-same-namespace-2", uuid]); h.dispose();
});

test("C2 requests-only usage and mixed envelope preserve all known requests with tokens/cost unknown", () => {
	const requestOnly = { requests: { total: 3, cacheKnown: 0, usageKnown: 0 } };
	const h = harness(); const first = h.apply(child("request-only", "t-ns-1", requestOnly));
	assert.deepEqual(first.details.forgeSubagentUsage.runs[0].usage, requestOnly);
	const second = child("known", "t-ns-2"); second.toolCallId = "root/2"; h.apply(second);
	const result = h.apply(root()); const runs = getSubagentUsageReceipts([entry(result)]);
	assert.equal(runs.length, 2); assert.equal(runs.reduce((n, r) => n + r.usage.requests!.total, 0), 4);
	assert.equal(runs[0].usage.tokens, undefined); assert.equal(runs[0].usage.cost, undefined);
	assert.equal(result.details.forgeNestedUsage, undefined, "v1 cannot express unknown tokens without inventing zeros"); h.dispose();
});

test("C3 reused root/1 across generations rejects ambiguous late result and never contaminates new root", () => {
	const h = harness(); h.fire("tool_call", root()); h.fire("tool_call", child("old-response"));
	h.switch(); h.fire("tool_call", root()); h.fire("tool_call", child("new-response"));
	const oldLate = h.apply(child("old-response"));
	assert.equal(oldLate.details.forgeSubagentUsageError?.code, "receipt-accounting-incomplete");
	assert.equal(oldLate.details.forgeSubagentUsage, undefined);
	const newResult = h.apply(child("new-response")); assert.equal(newResult.details.forgeSubagentUsage, undefined);
	const newRoot = h.apply(root()); assert.equal(newRoot.details.forgeSubagentUsage, undefined); assert.equal(newRoot.details.forgeSubagentUsageError?.code, "receipt-accounting-incomplete");
	assert.throws(() => getSubagentUsageReceipts([entry(newRoot)]), /Incomplete/); h.dispose();
});

for (const intent of ["session_before_switch", "session_before_fork"]) test(`C4 cancelled ${intent} retains valid pending receipts and in-flight generation`, () => {
	const h = harness(); h.fire("tool_call", root()); h.apply(child());
	h.fire(intent); // another extension cancels; no actual session_start / tree event
	const result = h.apply(root()); assert.equal(result.details.forgeSubagentUsage.runs.length, 1); assert.equal(result.details.forgeNestedUsage.requests, 1); h.dispose();
});

test("C5 forwarded child forgeNestedUsage is not independently added to pending receipts", () => {
	const h = harness(); const result = h.apply(child());
	const forwarded = h.apply(root({ forgeNestedUsage: result.details.forgeNestedUsage }));
	assert.equal(forwarded.details.forgeNestedUsage.requests, 1); assert.equal(forwarded.details.forgeNestedUsage.input, 10);
	assert.equal(getSubagentUsageReceipts([entry(forwarded)]).length, 1); h.dispose();
});

test("C5 unprovable existing nested coverage is explicitly incomplete, never an invented sum", () => {
	const h = harness(); h.apply(child()); const input = root({ forgeNestedUsage: { schemaVersion: 1, requests: 2, input: 7, output: 8, cacheRead: 1, cacheWrite: 0 } });
	const result = h.apply(input); assert.equal(result.details.forgeSubagentUsageError?.code, "receipt-accounting-incomplete");
	assert.equal(result.details.forgeNestedUsage, undefined); assert.strictEqual(result.usage, input.usage); assert.strictEqual(result.content, input.content);
	assert.throws(() => getSubagentUsageReceipts([entry(result)]), /Incomplete/); h.dispose();
});

test("C5 equal numeric cloned summaries do not prove forwarding lineage", () => {
	const h = harness(); const childResult = h.apply(child());
	const result = h.apply(root({ forgeNestedUsage: structuredClone(childResult.details.forgeNestedUsage) }));
	assert.equal(result.details.forgeSubagentUsageError?.code, "receipt-accounting-incomplete"); assert.equal(result.details.forgeNestedUsage, undefined); h.dispose();
});

test("C2 mixed requests-only envelope cannot inherit a partial known-token standard total", () => {
	const h = harness(); h.apply(child("requests-only", "t-namespace-1", { requests: { total: 3, cacheKnown: 0, usageKnown: 0 } }));
	const second = child("known", "t-namespace-2"); second.toolCallId = "root/2"; const known = h.apply(second);
	const result = h.apply(root({ forgeNestedUsage: known.details.forgeNestedUsage }));
	const runs = getSubagentUsageReceipts([entry(result)]);
	assert.equal(runs.reduce((n, r) => n + r.usage.requests!.total, 0), 4); assert.equal(result.details.forgeNestedUsage, undefined); h.dispose();
});
