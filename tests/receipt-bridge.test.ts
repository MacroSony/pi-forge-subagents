import assert from "node:assert/strict";
import test from "node:test";
import { getSubagentUsageReceipts, registerForgeSubagentUsageBridge } from "../src/usage/receipts.ts";
import { mapForgeSubagentUsage } from "../src/tool/forge-subagent-usage.ts";

const usage = { tokens: { input: 10, output: 20, cacheRead: 3, cacheWrite: 0, total: 33 }, requests: { total: 1, cacheKnown: 1, usageKnown: 1 }, cost: { amount: 0.5, currency: "USD", breakdown: { input: 0.2, output: 0.2, cacheRead: 0.1, cacheWrite: 0 } } };
function leaf(id = "actual-response-1", overrides: any = {}) {
	return { type: "tool_result", toolName: "forge_subagent", toolCallId: "outer/1", parentToolCallId: "outer", content: [{ type: "text", text: "PRIVATE OUTPUT" }], structuredContent: { untouched: true }, isError: false, usage: mapForgeSubagentUsage(usage).native, input: { task: "PRIVATE TASK" }, details: { runId: "short123", profileId: "project:worker", response: { runId: id, model: { provider: "virtual", id: "selected-model" }, status: "completed", usage, output: { text: "PRIVATE OUTPUT" }, secret: "SECRET" }, forgeNestedUsage: mapForgeSubagentUsage(usage).nested }, ...overrides };
}
const entry = (m: any) => ({ type: "message", message: { ...m, role: "toolResult" } });
function harness(unsubscribe = true) {
	const handlers = new Map<string, Set<any>>();
	const dispose = registerForgeSubagentUsageBridge({ on: (name: string, fn: any) => { const set = handlers.get(name) ?? new Set(); set.add(fn); handlers.set(name, set); return unsubscribe ? () => set.delete(fn) : undefined; } } as any);
	let id = "session1";
	const fire = (name: string, event: any = {}) => { let result: any; for (const fn of handlers.get(name) ?? []) result = fn(event, { sessionManager: { getSessionId: () => id } }) ?? result; return result; };
	const apply = (event: any) => ({ ...event, ...fire("tool_result", event) });
	return { apply, fire, dispose, setSession: (v: string) => { id = v; } };
}
const outer = (id = "outer", parentToolCallId?: string) => ({ type: "tool_result", toolName: "wrapper", toolCallId: id, ...(parentToolCallId ? { parentToolCallId } : {}), details: { keep: true }, content: [{ type: "text", text: "wrapper" }], structuredContent: { output: "keep" }, isError: true, usage: { some: "native" } });

test("direct legacy requires credited evidence, excludes background false and unrelated tools", () => {
	const l = leaf();
	const task = { ...l, toolName: "forge_subagent_task", details: { ...l.details, action: "result", task: { id: "bg123456", profileId: "project:bg" }, usageCredited: true } };
	assert.equal(getSubagentUsageReceipts([entry(l), entry({ ...l, details: { response: l.details.response } }), entry({ ...l, toolName: "other" })]).length, 1);
	assert.equal(getSubagentUsageReceipts([entry({ ...task, details: { ...task.details, usageCredited: false } })]).length, 0);
	assert.equal(getSubagentUsageReceipts([entry({ ...task, details: { ...task.details, action: "cancel" } })]).length, 0);
	assert.equal(getSubagentUsageReceipts([entry(task)])[0].taskId, "bg123456");
});

test("receipt contains accounting only, real runId and short prepared id, selected model", () => {
	const h = harness(); const result = h.apply(leaf());
	const runs = getSubagentUsageReceipts([entry(result)]);
	assert.equal(runs[0].runId, "actual-response-1"); assert.equal(runs[0].taskId, "short123");
	assert.deepEqual(runs[0].model, { provider: "virtual", id: "selected-model" });
	assert.doesNotMatch(JSON.stringify(result.details.forgeSubagentUsage), /PRIVATE|SECRET|physical|output.*text/);
	h.dispose();
});

test("recursive propagation preserves content/structuredContent/errors/native identity and dedupes", () => {
	const h = harness(); const l = leaf("actual", { parentToolCallId: "outer/1", toolCallId: "outer/1/1" });
	const result = h.apply(l);
	assert.strictEqual(result.content, l.content); assert.strictEqual(result.usage, l.usage); assert.strictEqual(result.structuredContent, l.structuredContent); assert.equal(result.isError, l.isError);
	const mid = h.apply(outer("outer/1", "outer")); const rootInput = outer(); const root = h.apply(rootInput);
	assert.deepEqual(root.details.forgeNestedUsage, l.details.forgeNestedUsage);
	assert.equal(getSubagentUsageReceipts([entry(result), entry(mid), entry(root)]).length, 1);
	for (const key of ["content", "structuredContent", "usage", "isError"] as const) assert.strictEqual(root[key], rootInput[key]);
	h.dispose();
});

test("parallel siblings and independent roots never bleed, continuation is a new response delta", () => {
	const h = harness(); h.apply(leaf("r1")); h.apply(leaf("r2", { toolCallId: "other/1", parentToolCallId: "other" })); h.apply(leaf("r3", { toolCallId: "outer/2" }));
	const a = h.apply(outer()); const b = h.apply(outer("other"));
	assert.equal(a.details.forgeSubagentUsage.runs.length, 2); assert.equal(b.details.forgeSubagentUsage.runs.length, 1);
	assert.equal(a.details.forgeNestedUsage.input, 20);
	assert.equal(getSubagentUsageReceipts([entry(a), entry(b)]).length, 3);
	h.dispose();
});

for (const status of ["failed", "cancelled", "timed-out", "limit-reached"]) test(`${status} partial usage is retained with mixed/unknown cache coverage`, () => {
	const h = harness(); const l = leaf(); const partial = { ...usage, requests: { total: 2, cacheKnown: 1, usageKnown: 1 } };
	l.details.response.status = status; l.details.response.usage = partial; l.details.forgeNestedUsage = mapForgeSubagentUsage(partial).nested!;
	const root = (h.apply(l), h.apply(outer()));
	assert.equal(root.details.forgeSubagentUsage.runs[0].status, status);
	assert.deepEqual(root.details.forgeNestedUsage, { schemaVersion: 1, requests: 2, input: 10, output: 20 });
	h.dispose();
});

for (const lifecycle of ["session_start", "session_tree", "session_shutdown"]) test(`${lifecycle} clears pending receipts`, () => {
	const h = harness(); h.apply(leaf()); h.fire(lifecycle); assert.equal(h.apply(outer()).details.forgeSubagentUsage, undefined); h.dispose();
});
for (const intent of ["session_before_switch", "session_before_fork"]) test(`${intent} does not invalidate a receipt before an actual change`, () => {
	const h = harness(); h.apply(leaf()); h.fire(intent); assert.equal(h.apply(outer()).details.forgeSubagentUsage.runs.length, 1); h.dispose();
});

test("session identity change and void-on legacy dispose are safe; 0.87 direct fallback", () => {
	const h = harness(false); h.apply(leaf()); h.setSession("session2"); assert.equal(h.apply(outer()).details.forgeSubagentUsage, undefined);
	const direct = h.apply(leaf("direct", { parentToolCallId: undefined })); assert.equal(getSubagentUsageReceipts([entry(direct)]).length, 1);
	h.dispose(); assert.equal(h.apply(leaf()).details.forgeSubagentUsage, undefined);
});

test("duplicate receipt vs conflicting same runId; invalid and forged background envelopes fail closed", () => {
	const h = harness(); const result = h.apply(leaf()); assert.equal(getSubagentUsageReceipts([entry(result), entry(result)]).length, 1);
	const bad = structuredClone(result); bad.details.forgeSubagentUsage.runs[0].usage.tokens.input = -1;
	assert.throws(() => getSubagentUsageReceipts([entry(bad)]), /Invalid/);
	const conflicting = structuredClone(result); conflicting.details.forgeSubagentUsage.runs[0].model.id = "different";
	assert.throws(() => getSubagentUsageReceipts([entry(result), entry(conflicting)]), /Conflicting/);
	assert.equal(getSubagentUsageReceipts([entry({ ...result, details: { ...result.details, usageCredited: false } })]).length, 0);
	h.apply(leaf("actual-response-1", { toolCallId: "outer/2", details: conflicting.details })); const root = h.apply(outer());
	assert.equal(root.details.forgeSubagentUsageError.code, "receipt-accounting-incomplete"); assert.throws(() => getSubagentUsageReceipts([entry(root)]), /Incomplete/); h.dispose();
});

test("mixed other-tool native usage is unchanged; unproven existing nested coverage fails explicitly", () => {
	const h = harness(); h.apply(leaf()); const input = outer(); input.details = { keep: true, forgeNestedUsage: { schemaVersion: 1, requests: 2, input: 7, output: 8, cacheRead: 1, cacheWrite: 0 } } as any;
	const root = h.apply(input); assert.strictEqual(root.usage, input.usage); assert.equal(root.details.forgeNestedUsage, undefined); assert.equal(root.details.forgeSubagentUsageError.code, "receipt-accounting-incomplete"); assert.throws(() => getSubagentUsageReceipts([entry(root)]), /Incomplete/); h.dispose();
});

test("scope cap persists explicit incompleteness instead of silently dropping totals", () => {
	const h = harness(); let result: any;
	for (let i = 0; i < 1025; i++) result = h.apply(leaf(`run${i}`, { toolCallId: `root${i}/1`, parentToolCallId: `root${i}` }));
	assert.equal(result.details.forgeSubagentUsageError.code, "receipt-accounting-incomplete");
	assert.equal(h.apply(outer("root0")).details.forgeSubagentUsageError.code, "receipt-accounting-incomplete");
	h.fire("session_start"); assert.ok(h.apply(leaf()).details.forgeSubagentUsage); h.dispose();
});
