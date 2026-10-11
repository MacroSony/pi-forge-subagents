import assert from "node:assert/strict";
import test from "node:test";
import { getSubagentUsageReceipts, registerForgeSubagentUsageBridge } from "../src/usage/receipts.ts";
import { mapForgeSubagentUsage } from "../src/tool/forge-subagent-usage.ts";
const usage = { tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, total: 33 }, requests: { total: 1, cacheKnown: 1, usageKnown: 1 }, cost: { amount: 0.5, currency: "USD", breakdown: { input: 0.2, output: 0.2, cacheRead: 0.1, cacheWrite: 0 } } };
const entry = (m: any) => ({ type: "message", message: { role: "toolResult", ...m } });
function direct(u: any = usage): any { return { toolName: "forge_subagent", toolCallId: "root/1", parentToolCallId: "root", usage: mapForgeSubagentUsage(usage).native, details: { runId: "task1234", response: { runId: "actual-id", status: "completed", model: { provider: "selected", id: "model" }, usage: u } } }; }

test("credited pre-coverage direct legacy is readable but request/cache coverage is not guessed", () => {
	const legacy = { tokens: usage.tokens, cost: usage.cost };
	const result = direct(legacy);
	const runs = getSubagentUsageReceipts([entry(result)]);
	assert.equal(runs.length, 1); assert.equal(runs[0].usage.requests, undefined);
	delete result.usage; assert.equal(getSubagentUsageReceipts([entry(result)]).length, 0);
});

test("legacy native proof ignores property insertion order, rejects mismatched native totals", () => {
	const result = direct(); result.usage = { cost: result.usage.cost, totalTokens: 33, cacheWrite: 0, cacheRead: 3, output: 20, input: 10 };
	assert.equal(getSubagentUsageReceipts([entry(result)]).length, 1);
	result.usage.input = 999; assert.equal(getSubagentUsageReceipts([entry(result)]).length, 0);
});

test("late old-session tool results cannot repopulate new-session bridge metadata", () => {
	const handlers = new Map<string, any>(); let sessionId = "old";
	const dispose = registerForgeSubagentUsageBridge({ on: (name: string, handler: any) => { handlers.set(name, handler); return () => handlers.delete(name); } } as any);
	const ctx = { sessionManager: { getSessionId: () => sessionId } };
	const fire = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
	fire("tool_call", { toolCallId: "root" }); fire("tool_call", { toolCallId: "root/1", parentToolCallId: "root" });
	fire("session_before_switch"); sessionId = "new"; fire("session_start");
	assert.equal(fire("tool_result", direct()), undefined);
	assert.equal(fire("tool_result", { toolCallId: "root", toolName: "codemode", details: {} }), undefined);
	const next = direct(); next.toolCallId = "new/1"; next.parentToolCallId = "new";
	fire("tool_call", next); assert.equal(fire("tool_result", next).details.forgeSubagentUsage.runs.length, 1);
	assert.equal(fire("tool_result", { toolCallId: "new", toolName: "codemode", details: {} }).details.forgeSubagentUsage.runs.length, 1);
	dispose(); assert.equal(handlers.size, 0);
});

test("unsafe aggregate overflow persists explicit error while preserving native/content", () => {
	const handlers = new Map<string, any>(); const ctx = { sessionManager: { getSessionId: () => "s" } };
	const dispose = registerForgeSubagentUsageBridge({ on: (name: string, handler: any) => { handlers.set(name, handler); } } as any);
	for (let i = 0; i < 2; i++) {
		const result = direct(); const big = { tokens: { input: Number.MAX_SAFE_INTEGER, output: 0, total: Number.MAX_SAFE_INTEGER }, requests: { total: 1, cacheKnown: 0, usageKnown: 0 } };
		result.toolCallId = `root/${i}`; result.details.response.runId = `actual-${i}`; result.details.response.usage = big; result.details.forgeNestedUsage = mapForgeSubagentUsage(big).nested; delete result.usage;
		handlers.get("tool_result")(result, ctx);
	}
	const input = { toolCallId: "root", toolName: "codemode", details: { keep: true }, usage: { unchanged: true }, content: [{ text: "unchanged" }], isError: false };
	const hook = handlers.get("tool_result")(input, ctx);
	assert.equal(hook.details.forgeSubagentUsageError.code, "receipt-accounting-incomplete");
	assert.deepEqual(Object.keys(hook), ["details"]); assert.throws(() => getSubagentUsageReceipts([entry({ ...input, ...hook })]), /Incomplete/);
	dispose();
});

test("actual response identity dedupes across persisted roots and public branch reopen", () => {
	const handlers = new Map<string, any>(); let branch: any[] = [];
	const ctx = { sessionManager: { getSessionId: () => "s", getBranch: () => branch } };
	const dispose = registerForgeSubagentUsageBridge({ on: (name: string, handler: any) => { handlers.set(name, handler); } } as any);
	const root = direct(); delete root.parentToolCallId;
	const first = { ...root, ...handlers.get("tool_result")(root, ctx) }; branch.push(entry(first));
	assert.equal(first.details.forgeNestedUsage.requests, 1);
	const replay = { ...root, toolCallId: "second" }; const second = { ...replay, ...handlers.get("tool_result")(replay, ctx) };
	assert.equal(second.details.forgeNestedUsage.requests, 0); assert.equal(second.details.forgeNestedUsage.input, 0); assert.strictEqual(second.usage, root.usage);
	assert.equal(getSubagentUsageReceipts([entry(first), entry(second)]).length, 1);
	handlers.get("session_start")();
	const reopened = { ...replay, ...handlers.get("tool_result")(replay, ctx) }; assert.equal(reopened.details.forgeNestedUsage.requests, 0);
	dispose();
});

test("runtime prepared:/run: IDs retain complete metadata identity; display belongs to UI", () => {
	const a = direct(); delete a.details.runId; a.details.response.runId = "run:bbbbbbbb-1111-2222-3333-444444444444"; a.details.response.preparedRunId = "prepared:aaaaaaaa-1111-2222-3333-444444444444";
	const b = direct(); delete b.details.runId; b.details.response.runId = "run:cccccccc-1111-2222-3333-444444444444";
	const runs = getSubagentUsageReceipts([entry(a), entry(b)]);
	assert.deepEqual(runs.map((r) => r.taskId), [a.details.response.preparedRunId, b.details.response.runId]);
	assert.equal(new Set(runs.map((r) => r.taskId)).size, 2);
	assert.equal(runs[0].runId, a.details.response.runId);
});
