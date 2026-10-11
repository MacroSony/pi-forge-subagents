import assert from "node:assert/strict";
import test from "node:test";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";
import { registerForgeSubagentTaskTool } from "../src/tool/forge-subagent-task.ts";

const theme: any = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;:]*m/g, "");
const execution = { model: { provider: "openai-codex", id: "gpt-6.1-sol" }, thinkingLevel: "low", backendId: "pi-inprocess", runId: "LONG-RUN-ID-SECRET", mode: "background", contextMode: "retained" };
const response = { model: execution.model, durationMs: 1700, usage: { requests: { total: 1, usageKnown: 1, cacheKnown: 1 }, tokens: { input: 700, output: 13, total: 713, cacheRead: 0, cacheWrite: 0 }, cost: { amount: 0.0015, currency: "USD" } } };
const attack = "\x1b[2J\x1b]52;c;OSC-SECRET\x07\u009b2J\u009d0;C1-SECRET\u009c\x1b[31m";
function tools() {
	let foreground: any; let management: any;
	const runtime: any = { backendIds: () => [], descriptors: () => [] };
	registerForgeSubagentTool({ registerTool: (t: any) => { foreground = t; } } as any, runtime, { sessionProvider: () => undefined });
	registerForgeSubagentTaskTool({ registerTool: (t: any) => { management = t; } } as any, runtime, () => undefined);
	return { foreground, management };
}
function details(extra: any = {}) {
	return { status: "completed", profileId: "global:inspector", task: "Review parser", execution, response, approval: { required: false, approved: true, source: "trusted-project-config", viewedFullPrompt: false }, diagnostics: [], progress: [], ...extra };
}
function task(extra: any = {}) {
	return { id: "LONG-TASK-ID-SECRET", title: "Review parser", profileId: "global:inspector", status: "completed", collected: true, execution, ...extra };
}
function render(tool: any, d: any, width: number, output = "", expanded = false, styling = theme): string[] {
	return tool.renderResult({ details: d, content: [{ type: "text", text: output }] }, { expanded, isPartial: false }, styling).render(width).map((line: string) => stripSgr(line).trimEnd());
}
function bounded(lines: string[], width: number) {
	for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
}

for (const width of [60, 100, 160, 240]) {
	test(`real cards are sanitized, one-line titled and cell-bounded at width ${width}`, () => {
		const { foreground, management } = tools();
		const cleanTitle = "审查代码🧪👩‍💻e\u0301".repeat(80);
		const title = cleanTitle + attack;
		const variants = [
			[foreground, details({ task: title })],
			[foreground, details({ task: title, status: "running", response: undefined, background: true })],
			[management, { action: "status", tasks: [task({ title })] }],
			[management, { action: "cancel", task: task({ title, status: "cancelled" }) }],
			[management, { action: "result", task: task({ title }), response, usageCredited: true }],
		] as const;
		for (const [tool, d] of variants) {
			const lines = render(tool, d, width, "安全结果🧪e\u0301".repeat(30) + attack + "\nsecond\nthird");
			bounded(lines, width);
			assert.match(lines[0]!, /completed|cancelled|background started/);
			const expectedTitle = "  " + stripSgr(truncateToWidth(cleanTitle, width - 2, "…"));
			assert.equal(lines.filter((line) => line === expectedTitle).length, 1);
			assert.ok(expectedTitle.endsWith("…"));
			assert.doesNotMatch(lines.join("\n"), /OSC-SECRET|C1-SECRET|[\x00-\x09\x0b-\x1f\x7f-\x9f]|LONG-(?:TASK|RUN)-ID-SECRET|third/);
			assert.ok(lines.some((line) => line.includes("gpt-6.1-sol") && line.includes("thinking low")));
		}
		const completed = render(management, { action: "result", task: task({ title, profileId: "global:inspector-long-label" }), response: { ...response, durationMs: 83_400 } }, width);
		if (width === 60) {
			assert.equal(completed[0], "✓ completed · collected");
			assert.match(completed[1]!, /^  kept context · 1min 23\.4s · ≈ USD 0\.0015$/);
			assert.ok(completed.includes("  global:inspector-long-label"));
		} else {
			assert.match(completed[0]!, /completed · collected   kept context · 1min 23\.4s · ≈ USD 0\.0015/);
		}
	});
}

test("adjacent info wraps without loss, and result credit flag alone controls the neutral marker", () => {
	const { management } = tools();
	for (const width of [60, 100, 160, 240]) {
		const first = render(management, { action: "result", task: task(), response, usageCredited: true }, width);
		assert.doesNotMatch(first.join("\n"), /no new usage|task total/);
		const second = render(management, { action: "result", task: task(), response, usageCredited: false }, width);
		bounded(second, width);
		assert.match(second.join("\n"), /no new usage credited/);
		assert.match(second.join("\n"), /task total 1\.7s/);
		assert.match(second.join("\n"), /≈\s+USD 0\.0015/);
		assert.equal(second.join("\n").split("≈").length - 1, 1);
		if (width >= 100) assert.match(second[0]!, /no new usage credited/);
		else assert.match(second[1]!, /^  no new usage credited/);
	}
	for (const action of ["status", "cancel", "result"]) {
		const noResponse = render(management, { action, task: task(), usageCredited: false }, 100);
		assert.doesNotMatch(noResponse.join("\n"), /no new usage credited|task total/);
		if (action !== "result") assert.doesNotMatch(render(management, { action, task: task(), response, usageCredited: false }, 160).join("\n"), /no new usage credited/);
	}
});

test("previews trim trailing whitespace; lists have a spacer only between cards", () => {
	const { foreground, management } = tools();
	for (const width of [60, 100, 160, 240]) {
		const lines = render(foreground, details(), width, "LOW-CONTEXT-OK 7319   \n\n");
		bounded(lines, width);
		assert.equal(lines.indexOf("  LOW-CONTEXT-OK 7319") + 1, lines.findIndex((line) => line.includes("1 req")));
		assert.ok(lines.every(Boolean));
		const single = render(management, { action: "status", tasks: [task()] }, width);
		const multiple = render(management, { action: "status", tasks: [task(), task({ title: "Second task" })] }, width);
		assert.ok(single.every(Boolean));
		assert.equal(multiple.filter((line) => !line).length, 1);
		assert.equal(multiple[single.length], "");
		assert.ok(multiple[0]); assert.ok(multiple.at(-1));
	}
});

test("failed preparation is full and deduped collapsed, but expanded keeps diagnostics and audit details", () => {
	const { foreground } = tools();
	const message = "Continuation model/thinking changed; prepare a new child. " + "Detailed preparation failure with 中文🧪. ".repeat(10);
	const diagnostics = [
		{ level: "error", code: "prepare.continuation", message: message.trimEnd() },
		{ level: "warning", code: "prepare.echo", message: message.trimEnd() },
		{ level: "error", code: "prepare.continuation", message: message.trimEnd() },
	];
	const d = details({ status: "failed", response: undefined, diagnostics });
	for (const width of [60, 100, 160, 240]) {
		const lines = render(foreground, d, width, "Subagent preparation failed:\nERROR: " + message);
		bounded(lines, width);
		const compact = lines.join("").replace(/\s+/g, "");
		assert.equal(compact.split(message.trim().replace(/\s+/g, "")).length - 1, 1);
		assert.doesNotMatch(lines.join("\n"), /…|\.\.\./);
		const expanded = render(foreground, d, width, "Subagent preparation failed:\nERROR: " + message, true);
		bounded(expanded, width);
		assert.match(expanded.join("\n"), /WARNING: Continuation/);
		assert.match(expanded.join("\n"), /Delegated task|Approval:/);
	}
});

test("title is text, not bold, launch truncates with ellipsis and has no fixed 100-character render cap", () => {
	const { foreground } = tools();
	const styling = { ...theme, bold: (text: string) => `<bold>${text}</bold>` };
	const title = "Task " + "a".repeat(300);
	const lines = render(foreground, details({ task: title, background: true, status: "running", response: undefined }), 240, "", false, styling);
	assert.match(lines[0]!, /<bold>background started<\/bold>/);
	assert.equal(lines[1], "  " + stripSgr(truncateToWidth(title, 238, "…")));
	assert.doesNotMatch(lines[1]!, /bold/);
	assert.ok(visibleWidth(lines[1]!) > 100);
});

test("semantic colors, thinking tokens, distinct warnings and expanded-only info", () => {
	const { foreground } = tools();
	const calls: [string, string][] = [];
	const styling = { fg: (token: string, text: string) => { calls.push([token, text]); return text; }, bold: (text: string) => text };
	for (const [status, icon, color] of [["completed", "✓", "success"], ["failed", "✗", "error"], ["running", "●", "accent"], ["prepared", "●", "accent"], ["cancelled", "○", "muted"], ["unknown", "○", "muted"]]) {
		calls.length = 0;
		render(foreground, details({ status, response: undefined }), 100, "", false, styling);
		assert.ok(calls.some(([token, text]) => token === color && text === icon));
		assert.ok(calls.some(([token, text]) => token === color && text === status));
	}
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "unknown"]) {
		calls.length = 0;
		render(foreground, details({ execution: { ...execution, thinkingLevel: level } }), 160, "", false, styling);
		const token = level === "unknown" ? "muted" : `thinking${level[0]!.toUpperCase()}${level.slice(1)}`;
		assert.ok(calls.some(([color, text]) => color === token && text === level));
	}
	calls.length = 0;
	const d = details({ diagnostics: [
		{ level: "warning", code: "a", message: "First distinct warning" },
		{ level: "warning", code: "a", message: "First distinct warning" },
		{ level: "warning", code: "a", message: "Second distinct warning" },
		{ level: "warning", code: "pi-inprocess.shared-user", message: "Shared permissions risk" },
		{ level: "warning", code: "tools.none", message: "No tools available" },
		{ level: "info", code: "audit", message: "Only expanded audit info" },
	] });
	const collapsed = render(foreground, d, 160, "", false, styling).join("\n");
	assert.equal(collapsed.split("First distinct warning").length - 1, 1);
	assert.match(collapsed, /Second distinct warning/);
	assert.doesNotMatch(collapsed, /Only expanded audit info/);
	assert.ok(calls.some(([token, text]) => token === "dim" && text === "shared-user · no OS isolation"));
	assert.ok(calls.some(([token, text]) => token === "warning" && text === "No tools"));
	assert.match(render(foreground, d, 160, "", true).join("\n"), /Only expanded audit info/);
});

test("failed management operations render only the error, never an invented task/model line", () => {
	const { management } = tools();
	const lines = render(management, { action: "result", status: "failed" }, 80, "Subagent task operation failed: Unknown background task in this parent session.");
	assert.match(lines[0]!, /✗ failed/);
	assert.ok(lines.join("\n").includes("Unknown background task in this parent session."));
	assert.ok(!lines.join("\n").includes("model unresolved"));
	assert.ok(!lines.join("\n").includes("forge subagent task"));
});

test("cards without a title omit the title line instead of repeating the profile", () => {
	const { foreground, management } = tools();
	const expanded = render(foreground, details(), 100, "done", true);
	assert.equal(expanded.filter((line) => line.includes("global:inspector")).length, 1, expanded.join("\n"));
	const status = render(management, { action: "status", tasks: [task({ title: undefined })] }, 100);
	assert.match(status[0]!, /✓ completed · collected/);
	assert.match(status[1]!, /^ {2}global:inspector · openai-codex\/gpt-6\.1-sol · thinking low$/);
	assert.equal(status.length, 2, status.join("\n"));
});
