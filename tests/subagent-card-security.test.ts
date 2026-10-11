import assert from "node:assert/strict";
import test from "node:test";
import { renderSubagentCard, subagentUsageText } from "../src/ui/subagent-card.ts";
import { executionDisplayLines } from "../src/ui/execution-display.ts";
import { registerForgeSubagentTool, requestForgeSubagentApproval } from "../src/tool/forge-subagent.ts";
import { registerForgeSubagentTaskTool } from "../src/tool/forge-subagent-task.ts";

const attack = "\x1b[2J\x1b[H\x1b]52;c;CLIP_PAYLOAD\x07\u009b2J\u009d0;TITLE_PAYLOAD\u009c\x1b_APC_PAYLOAD\x1b\\\u009fC1_APC_PAYLOAD\u009c\u0090DCS_PAYLOAD\u009c\x1b[31m";
const theme: any = { fg: (_: string, text: string) => `\x1b[32m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const unstyled: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
function safeRendered(text: string) {
	// Only theme/Markdown-generated SGR is allowed in these fixtures, never cursor/OSC/APC instructions.
	assert.doesNotMatch(text.replace(/\x1b\[[0-9;:]*m/g, ""), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
	assert.doesNotMatch(text, /CLIP_PAYLOAD|TITLE_PAYLOAD|APC_PAYLOAD|DCS_PAYLOAD|\x1b\[31m/);
}
function tools() {
	let tool: any; let management: any;
	const runtime: any = { backendIds: () => [], descriptors: () => [], prepare: async () => ({ ok: false, diagnostics: [] }), discard: async () => {}, execute: async () => {}, dispose: async () => {} };
	registerForgeSubagentTool({ registerTool: (t: any) => { tool = t; } } as any, runtime, { sessionProvider: () => undefined });
	registerForgeSubagentTaskTool({ registerTool: (t: any) => { management = t; } } as any, runtime, () => undefined);
	return { tool, management };
}
const execution: any = { model: { provider: "provider" + attack, id: "selected" + attack }, thinkingLevel: "high" + attack, backendId: "backend" + attack, cwd: "/cwd" + attack, runId: "r1" + attack, mode: "foreground", contextMode: "one-shot" };

test("card sanitizes every untrusted field before styling/Markdown and preserves raw payloads", () => {
	const card: any = {
		profileId: "worker" + attack, title: "Review 代码 🧪" + attack, status: "running" + attack, execution,
		response: { model: { provider: "reported" + attack, id: "different" + attack }, durationMs: 1234, usage: { requests: { total: 1, usageKnown: 1, cacheKnown: 1 }, cost: { amount: 0.25, currency: "EUR" + attack } } },
		requested: { model: "requested/model" + attack, thinkingLevel: "low" + attack }, output: "ok" + attack, progress: "progress" + attack,
		warnings: [{ level: "warning", code: "unknown", message: "warning" + attack }, "unknown warning" + attack], approvalBadge: "approval" + attack, details: ["detail" + attack],
	};
	const original = structuredClone(card);
	for (const expanded of [false, true]) {
		const text = renderSubagentCard(card, expanded, theme).render(180).join("\n");
		safeRendered(text); assert.match(text, /\x1b\[32m/, "theme color must survive sanitization"); assert.match(text.replace(/\x1b\[[0-9;:]*m/g, ""), /provider\/selected/); assert.match(text, /ok/);
	}
	assert.deepEqual(card, original, "rendering must not rewrite raw tool/receipt values");
	const unresolved = { ...card, execution: undefined, response: undefined, title: undefined };
	safeRendered(renderSubagentCard(unresolved, false, theme).render(180).join("\n"));
	safeRendered(executionDisplayLines(execution, card.response.model).join("\n"));
});

test("bare malicious child output cannot clear/cursor-move terminal in either preview or expanded Markdown", () => {
	const { tool } = tools();
	const result: any = { content: [{ type: "text", text: "ok\x1b[2J\x1b[H" }], details: { profileId: "worker", task: "Review", status: "completed", diagnostics: [], progress: [], approval: { approved: false, required: false, source: "none" } } };
	const original = structuredClone(result);
	for (const expanded of [false, true]) safeRendered(tool.renderResult(result, { expanded, isPartial: false }, theme).render(100).join("\n"));
	assert.deepEqual(result, original);
});

test("main/management fallback, contexts, action header and legacy results also sanitize", () => {
	const { tool, management } = tools();
	const contexts = [{ id: "c1" + attack, profileId: "worker" + attack, model: execution.model, thinkingLevel: "high" + attack, backendId: "backend" + attack, cwd: "/cwd" + attack }];
	for (const expanded of [false, true]) {
		const options = { expanded, isPartial: false };
		const content = [{ type: "text", text: "fallback" + attack }];
		safeRendered(tool.renderResult({ content }, options, theme).render(100).join("\n"));
		for (const details of [undefined, { action: "release" }, { status: "failed" }, { action: "contexts", contexts }]) {
			safeRendered(management.renderResult({ content, details }, options, theme).render(180).join("\n"));
		}
	}
	safeRendered(management.renderCall({ action: "status" + attack }, theme).render(100).join("\n"));
});

test("approval summary and full prompt UI sanitize without changing sealed prompt/choices", async () => {
	const prepared: any = { cwd: "/cwd" + attack, plan: { profile: { profileId: "worker" + attack, promptStackId: "stack" + attack }, model: execution.model, thinkingLevel: "high" + attack, backendId: "backend" + attack, systemPrompt: "system" + attack, messages: [], effectiveToolIds: [], access: { level: "read-only", executionBoundary: "shared-user", mounts: [], process: false }, executionFingerprint: "fp" + attack, conversationFingerprint: "cp" + attack }, diagnostics: [] };
	const original = structuredClone(prepared);
	const viewed: string[] = []; let selects = 0;
	const ctx: any = { ui: { select: async (title: string) => { viewed.push(title); return selects++ ? "Reject" : "View full prompt"; }, editor: async (_title: string, text: string) => { viewed.push(text); } } };
	await requestForgeSubagentApproval(prepared, "task" + attack, ctx);
	assert.ok(viewed.length >= 3); for (const text of viewed) safeRendered(text);
	assert.deepEqual(prepared, original);
});

test("partial and legacy unknown usage keep known subtotals/currency and show honest coverage", () => {
	const usage: any = { requests: { total: 3, usageKnown: 1, cacheKnown: 2 }, tokens: { input: 10, output: 20, total: 38, cacheRead: 8, cacheWrite: 0 }, cost: { amount: 0.25, currency: "EUR" } };
	const original = structuredClone(usage);
	const collapsed = subagentUsageText(usage);
	assert.match(collapsed, /usage partial/); assert.match(collapsed, /cache partial/); assert.match(collapsed, /cacheRead 8/); assert.match(collapsed, /cacheWrite 0/); assert.match(collapsed, /≈ EUR 0\.2500/);
	const expanded = renderSubagentCard({ profileId: "worker", status: "completed", response: { usage } as any }, true, unstyled).render(180).join("\n");
	assert.match(expanded, /coverage: usage 1\/3 · cache 2\/3/);
	assert.deepEqual(usage, original);
	const legacy: any = { tokens: { input: 5, output: 6, total: 11 }, cost: { amount: 0.75, currency: "JPY" } };
	const unknown = subagentUsageText(legacy);
	assert.match(unknown, /usage unknown/); assert.match(unknown, /cache unknown/); assert.doesNotMatch(unknown, /cacheRead|cacheWrite|0 req/); assert.match(unknown, /≈ JPY 0\.7500/);
	assert.match(subagentUsageText(legacy, true), /coverage: usage unknown\/unknown · cache unknown\/unknown/);
	const absentUsageKnown = subagentUsageText({ ...usage, requests: { total: 3, cacheKnown: 3 } });
	assert.match(absentUsageKnown, /usage unknown/); assert.doesNotMatch(absentUsageKnown, /cache (partial|unknown)/);
	const complete = subagentUsageText({ ...usage, requests: { total: 3, usageKnown: 3, cacheKnown: 3 } });
	assert.doesNotMatch(complete, /partial|unknown/);
	assert.match(subagentUsageText({ ...usage, requests: { total: 3, usageKnown: 3, cacheKnown: 3 } }, true), /coverage: usage 3\/3 · cache 3\/3/);
});

test("zero/missing coverage is unknown, never guessed from token or cost zeros", () => {
	const usage: any = { requests: { total: 2, usageKnown: 0, cacheKnown: 0 }, tokens: { input: 0, output: 0, total: 0 }, cost: { amount: 0, currency: "USD" } };
	const text = subagentUsageText(usage);
	assert.match(text, /usage unknown/); assert.match(text, /cache unknown/); assert.match(text, /0 input/); assert.match(text, /≈ USD 0\.0000/); assert.doesNotMatch(text, /cacheRead 0|cacheWrite 0/);
	const expanded = renderSubagentCard({ profileId: "worker", status: "completed", response: { usage } as any }, true, unstyled).render(180).join("\n");
	assert.match(expanded, /coverage: usage 0\/2 · cache 0\/2/);
});
