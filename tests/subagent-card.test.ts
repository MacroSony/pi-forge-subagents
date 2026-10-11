import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";
import { registerForgeSubagentTaskTool } from "../src/tool/forge-subagent-task.ts";

const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const execution = { model: { provider: "selected-provider", id: "selected-model" }, thinkingLevel: "high", backendId: "pi-inprocess", runId: "r1", mode: "foreground", contextMode: "one-shot" };
function tools() {
	let tool: any; let management: any;
	const runtime: any = { backendIds: () => [], descriptors: () => [], prepare: async () => ({ ok: false, diagnostics: [] }), discard: async () => {}, execute: async () => {}, dispose: async () => {} };
	registerForgeSubagentTool({ registerTool: (t: any) => { tool = t; } } as any, runtime, { sessionProvider: () => undefined });
	registerForgeSubagentTaskTool({ registerTool: (t: any) => { management = t; } } as any, runtime, () => undefined);
	return { tool, management };
}
function details(extra: any = {}) {
	return { status: "running", profileId: "project:worker", task: "Review code", approval: { required: false, approved: true, source: "trusted-project-config", viewedFullPrompt: false }, diagnostics: [], progress: [], execution, ...extra };
}
function render(tool: any, d: any, output = "", expanded = false, width = 180) {
	return tool.renderResult({ content: [{ type: "text", text: output }], details: d }, { expanded, isPartial: !expanded }, theme, {}).render(width).map((line: string) => line.trimEnd()).join("\n");
}

test("actual running without response shows sealed selected model and thinking", () => {
	const { tool } = tools();
	const text = render(tool, details());
	assert.match(text, /selected-provider\/selected-model/);
	assert.match(text, /thinking high/);
	assert.match(text, /running/);
	assert.doesNotMatch(text, /Approval:|per-run approval|0ms/);
});

test("background launch is a historical started event and hides plumbing only from collapsed UI", () => {
	const { tool } = tools();
	const content = "Background subagent launched: r1. Use forge_subagent_task with action status/result/cancel and this id. No result or usage is credited until result collection.";
	const d = details({ background: true, execution: { ...execution, mode: "background" } });
	const text = render(tool, d, content);
	assert.match(text, /background started/);
	assert.match(text, /thinking high/);
	assert.doesNotMatch(text, /running|live|Background subagent launched|Use forge_subagent_task/);
	assert.match(render(tool, d, content, true), /Use forge_subagent_task/);
});

test("two-line preview, expanded authorization, and selected/reported mismatch", () => {
	const { tool } = tools();
	const d = details({ status: "completed", response: { model: { provider: "reported", id: "other" }, durationMs: 731 } });
	const text = render(tool, d, "first\nsecond\nTHIRD\nFOURTH");
	assert.match(text, /selected.*selected-provider\/selected-model/);
	assert.match(text, /reported.*reported\/other/);
	assert.match(text, /0\.7s/);
	assert.doesNotMatch(text, /THIRD|FOURTH|per-run approval/);
	const expanded = render(tool, d, "first\nsecond\nTHIRD\nFOURTH", true);
	assert.match(expanded, /THIRD/);
	assert.match(expanded, /Approval: per-run approval bypassed/);
});

test("requested model before prepare and legacy thinking unknown are honest", () => {
	const { tool } = tools();
	const call = tool.renderCall({ profileId: "worker", task: "审查代码 🧪", model: "p/requested", thinkingLevel: "low" }, theme, {}).render(100).join("\n");
	assert.doesNotMatch(call, /requested|thinking low|审查代码/);
	const preparing = render(tool, details({ status: "preparing", execution: undefined, requested: { model: "p/requested", thinkingLevel: "low" } }));
	assert.match(preparing, /requested p\/requested/); assert.match(preparing, /thinking low/);
	const legacy = render(tool, details({ execution: undefined, response: { model: { provider: "old", id: "model" }, durationMs: 12 } }));
	assert.match(legacy, /old\/model/); assert.match(legacy, /thinking unknown/);
	assert.doesNotMatch(legacy, /thinking high|selected-provider/);
});

test("background management uses the same card for live status and collection", () => {
	const { management } = tools();
	const task = { id: "r1", profileId: "worker", status: "running", collected: false, execution: { ...execution, mode: "background" } };
	const status = render(management, { action: "status", tasks: [task] });
	assert.match(status, /selected-provider\/selected-model/); assert.match(status, /thinking high/); assert.match(status, /running/);
	const completed = { ...task, status: "completed", collected: true };
	const result = render(management, { action: "result", task: completed, response: { model: execution.model, durationMs: 345 } }, "one\ntwo\nTHREE");
	assert.match(result, /0\.3s/); assert.match(result, /collected/); assert.doesNotMatch(result, /THREE/);
	assert.match(render(management, { action: "result", task: completed }, "one\ntwo\nTHREE", true), /THREE/);
});

test("long CJK model labels wrap within narrow and wide terminal widths", () => {
	const { tool } = tools();
	const d = details({ execution: { ...execution, model: { provider: "很长的提供商", id: "模型🧪".repeat(30) } } });
	for (const width of [20, 40, 180]) {
		const lines = tool.renderResult({ content: [], details: d }, { expanded: false, isPartial: true }, theme, {}).render(width);
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
		assert.ok(lines.join("\n").includes("thinking high"));
	}
});

test("collapsed output stays at two physical terminal lines even for long paragraphs/CJK", () => {
	const { tool } = tools();
	const d = details({ status: "completed" });
	for (const width of [20, 40, 100]) {
		const base = tool.renderResult({ content: [], details: d }, { expanded: false, isPartial: false }, theme).render(width);
		const content = [{ type: "text", text: "证据🧪很长的结果".repeat(100) + "\nsecond\nthird" }];
		const preview = tool.renderResult({ content, details: d }, { expanded: false, isPartial: false }, theme).render(width);
		assert.equal(preview.length - base.length, 2);
		assert.ok(preview.every((line: string) => visibleWidth(line) <= width));
	}
});

const sharedWarning = "Access is enforced by the model-visible tool allowlist only; the subagent runs inside the host process with the invoking user's full permissions and no OS isolation.";
test("regular background launch is five combined lines, task once, selected metadata only and compact risk", () => {
	const { tool } = tools();
	const args = { profileId: "project:worker", task: "Review code", model: "requested/other", thinkingLevel: "low" };
	const call = tool.renderCall(args, theme, {}).render(110);
	const d = details({ background: true, execution: { ...execution, mode: "background" }, requested: { model: args.model, thinkingLevel: args.thinkingLevel }, diagnostics: [{ level: "warning", code: "pi-inprocess.shared-user", message: sharedWarning }] });
	const content = "Background subagent launched: r1. Use forge_subagent_task with action status/result/cancel and this id. No result or usage is credited until result collection.";
	const card = tool.renderResult({ content: [{ type: "text", text: content }], details: d }, { expanded: false, isPartial: false }, theme, {}).render(110);
	const combined = [...call, ...card].join("\n");
	assert.equal(call.length, 1); assert.equal(call.length + card.length, 5);
	assert.equal(combined.split("Review code").length - 1, 1);
	assert.match(combined, /project:worker · selected-provider\/selected-model · thinking high/);
	assert.match(combined, /shared-user · no OS isolation/);
	assert.doesNotMatch(combined, /requested|trusted config|one-shot|pi-inprocess|Access is enforced|Use forge_subagent_task|Approval:/);
	const expanded = render(tool, d, content, true);
	assert.match(expanded, /requested requested\/other/); assert.match(expanded, /Access is enforced/); assert.match(expanded, /Approval:/); assert.match(expanded, /Context: one-shot/);
});

test("unresolved choices are requested only in result, and same output/progress appears once", () => {
	const { tool } = tools();
	const pending = details({ status: "preparing", execution: undefined, requested: { model: "p/request", thinkingLevel: "low" } });
	assert.match(render(tool, pending), /requested p\/request · thinking low/);
	const text = render(tool, details({ progress: [{ phase: "tool-result", message: "read completed" }] }), "read completed");
	assert.equal(text.split("read completed").length - 1, 1);
	const expanded = render(tool, details({ progress: [{ phase: "tool-result", message: "read completed" }] }), "read completed", true);
	assert.equal(expanded.split("read completed").length - 1, 1);
});

test("usage shows known cache fields without inventing zeros; child durations are readable", () => {
	const { tool } = tools();
	const response: any = { model: execution.model, durationMs: 83_400, usage: { tokens: { input: 3, output: 4, total: 15, cacheRead: 8, cacheWrite: 0 } } };
	const known = render(tool, details({ status: "completed", response }));
	assert.match(known, /1min 23\.4s/); assert.match(known, /cacheRead 8/); assert.match(known, /cacheWrite 0/); assert.doesNotMatch(known, /83400ms/);
	delete response.usage.tokens.cacheRead; delete response.usage.tokens.cacheWrite; response.durationMs = 731;
	const unknown = render(tool, details({ status: "completed", response }));
	assert.match(unknown, /0\.7s/); assert.doesNotMatch(unknown, /cacheRead|cacheWrite/);
	response.usage.tokens.cacheRead = 8;
	const partial = render(tool, details({ status: "completed", response }));
	assert.match(partial, /cacheRead 8/); assert.doesNotMatch(partial, /cacheWrite/);
});

test("No tools and unknown warnings stay summarized collapsed, intact expanded", () => {
	const { tool } = tools();
	const message = "Unexpected backend restriction: " + "long explanatory details ".repeat(12);
	const d = details({ diagnostics: [{ level: "warning", code: "backend.restriction", message }], response: { model: execution.model, effectiveToolIds: [] } });
	const text = render(tool, d);
	assert.match(text, /No tools/); assert.match(text, /Unexpected backend restriction/); assert.ok(text.length < message.length + 240);
	assert.doesNotMatch(text, /the intersection|long explanatory details long explanatory details long explanatory details/);
	assert.ok(render(tool, d, "", true, 1000).includes(message.trim()));
});
