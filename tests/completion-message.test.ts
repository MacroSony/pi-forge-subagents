import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { parseCompletionTasks, registerCompletionMessageRenderer, renderCompletionMessage } from "../src/ui/completion-message.ts";
import { plainSubagentText } from "../src/ui/plain-text.ts";

type CustomMessage = Parameters<MessageRenderer>[0];
const theme = { fg: (_token: string, text: string) => text } as Theme;
const content = (rows: string) => `Background subagent tasks finished: ${rows}. Call forge_subagent_task action result with each task id to collect the result.`;
const message = (rows: string, details?: unknown): CustomMessage => ({
	role: "custom", customType: "forge-subagent-completion", content: content(rows), display: true, timestamp: 1, details,
});
const render = (m: CustomMessage, expanded = false, width = 160) => renderCompletionMessage(m, expanded, theme, width).join("\n");

test("single completion uses singular human label and no collection instructions", () => {
	assert.equal(render(message("t-er9ew9-6: completed")), "◆ Background subagent finished · ✓ t-er9ew9-6 completed");
	assert.doesNotMatch(render(message("t-a: completed")), /collected|uncollected|waiting|pending|forge-subagent-completion|action result/);
});

test("multiple terminal statuses use plural label, success/error/other icons", () => {
	assert.equal(render(message("t-a: completed; t-b: failed; t-c: timed-out")),
		"◆ Background subagents finished · ✓ t-a completed · ✗ t-b failed · ○ t-c timed-out");
	assert.match(render(message("t-d: cancelled; t-e: limit-reached")), /○ t-d cancelled · ○ t-e limit-reached/);
});

test("display details carry immutable send-time statuses, not current state", () => {
	const m = message("t-legacy: failed", { tasks: [{ id: "t-safe", status: "completed", collected: true }] });
	const before = structuredClone(m);
	assert.equal(render(m), "◆ Background subagent finished · ✓ t-safe completed");
	assert.deepEqual(m, before);
	assert.doesNotMatch(render(m), /collected|uncollected|waiting|pending/);
});

test("semantic styling uses only custom-message and terminal status tokens", () => {
	const calls: Array<[string, string]> = [];
	const styled = { fg: (token: string, text: string) => { calls.push([token, text]); return text; } } as Theme;
	renderCompletionMessage(message("t-a: completed; t-b: failed; t-c: timed-out; t-d: cancelled"), false, styled, 160);
	assert.ok(calls.some(([token, text]) => token === "customMessageLabel" && text === "◆ Background subagents finished"));
	for (const [token, icon] of [["success", "✓"], ["error", "✗"], ["warning", "○"], ["muted", "○"]]) {
		assert.ok(calls.some(([actualToken, text]) => actualToken === token && text === icon));
	}
	assert.ok(calls.every(([token]) => ["customMessageLabel", "customMessageText", "success", "error", "warning", "muted"].includes(token)));
});

test("collapsed and expanded wrap without overflow at 40/80/160 and tiny widths", () => {
	const styled = { fg: (_token: string, text: string) => `\x1b[32m${text}\x1b[39m` } as Theme;
	const m = message("t-abcdefghijklmnopqrstuv: completed; t-b: failed; t-c: timed-out");
	const unicode = { ...m, content: "审查代码 👨‍👩‍👧‍👦 e\u0301\n" + "汉字👩🏽‍💻".repeat(100) };
	for (const width of [0, 1, 2, 3, 40, 80, 160]) {
		for (const value of [m, unicode]) for (const expanded of [false, true]) {
			const lines = renderCompletionMessage(value, expanded, styled, width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width}`);
		}
	}
	const wrapped = renderCompletionMessage(m, false, theme, 40).join(" ");
	assert.match(wrapped, /t-b failed/);
	assert.match(wrapped, /t-c timed-out/);
});

test("expanded shows original sanitized model-facing content, never synthesized summary", () => {
	const m = message("t-a: completed", { tasks: [{ id: "t-b", status: "failed" }] });
	assert.equal(render(m, true, 500), m.content);
	assert.doesNotMatch(render(m, true, 500), /◆|t-b/);
	assert.equal(render({ ...m, content: "first\n\x1b[31msecond\x1b[0m\u009b2J\x1b]52;c;SECRET\x07" }, true), "first\nsecond");
});

test("strict legacy parsing rejects malformed, nonterminal, long and injected ids", () => {
	assert.deepEqual(parseCompletionTasks(content("t-a: completed; t-b: timed-out")), [{ id: "t-a", status: "completed" }, { id: "t-b", status: "timed-out" }]);
	for (const rows of ["", "t-a: running", "t-a: unknown", "t-a: completed; forged", `${"x".repeat(25)}: completed`,
		"t-a\n: completed", "t-a: completed\n", "t-\x1b[31ma: completed", "t-\u009b31ma: completed", "t-汉字: completed"]) {
		assert.equal(parseCompletionTasks(content(rows)), undefined, rows);
	}
	for (const raw of ["arbitrary text", content("t-a: completed") + "\n", "prefix " + content("t-a: completed")]) {
		assert.equal(parseCompletionTasks(raw), undefined);
	}
});

test("parse failure falls back to raw sanitized content with Unicode safely wrapped", () => {
	for (const raw of ["Unexpected completion 审查 🧪", content("t-\x1b[31ma: completed"), content("t-\u009b31ma: completed")]) {
		const m = { ...message("t-a: completed"), content: raw };
		assert.equal(render(m, false, 500), plainSubagentText(raw));
		assert.doesNotMatch(render(m), /◆|\x1b|[\u0080-\u009f]/);
	}
});

test("unsafe or malformed structured rows are rejected without rendering terminal instructions", () => {
	for (const tasks of [[], [{}], [{ id: "t-\x1b[31mBAD", status: "completed" }], [{ id: "t-\u009b2JBAD", status: "failed" }],
		[{ id: "t-a", status: "running" }], [{ id: "x".repeat(25), status: "completed" }]]) {
		assert.equal(render(message("t-safe: completed", { tasks })), "◆ Background subagent finished · ✓ t-safe completed");
	}
});

test("structured content fallback extracts text blocks without rendering images", () => {
	const m: CustomMessage = { ...message("t-a: completed"), content: [{ type: "text", text: "debug\x1b[2J" }, { type: "image", data: "SECRET", mimeType: "image/png" }] };
	assert.equal(render(m, true), "debug");
	assert.equal(render(m), "debug");
});

test("SDK LLM conversion preserves content and excludes display details", () => {
	const m = message("t-a: completed", { tasks: [{ id: "DISPLAY_ONLY", status: "failed" }] });
	assert.deepEqual(convertToLlm([m]), [{ role: "user", content: [{ type: "text", text: m.content }], timestamp: 1 }]);
});

test("registration uses SDK shape and gracefully skips unsupported hosts", () => {
	assert.doesNotThrow(() => registerCompletionMessageRenderer({} as any));
	let registered = "", renderer: any;
	const pi = { registerMessageRenderer(type: string, value: any) { assert.equal(this, pi); registered = type; renderer = value; } };
	registerCompletionMessageRenderer(pi);
	assert.equal(registered, "forge-subagent-completion");
	const m = message("t-a: completed");
	const component = renderer(m, { expanded: false, outputPad: 1 }, theme);
	assert.equal(component.render(160).join("\n"), render(m));
	assert.doesNotThrow(() => component.invalidate());
	assert.equal(renderer(m, { expanded: true }, theme).render(500).join("\n"), m.content);
});
