import assert from "node:assert/strict";
import test from "node:test";
import { ReadOnlySubagentView } from "../src/ui/read-only-view.ts";
import { subagentViewScopeGuard } from "../src/ui/view-scope.ts";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(tasks: { id: string; label: string; detail: () => string | Promise<string> }[] = []) {
	let scope = "original";
	let closes = 0;
	const view = new (ReadOnlySubagentView as any)(
		{ title: "Readonly", summary: "OLD-SCOPE-PRIVATE-SUMMARY", tasks },
		() => 20, () => undefined, () => { closes++; }, (s: string) => s, () => scope === "original",
	);
	return { view, change: () => { scope = "changed"; }, closes: () => closes };
}

test("a rendered view invalidates and closes when its session/branch scope changes", async () => {
	const h = harness();
	assert.match(h.view.render(90).join("\n"), /OLD-SCOPE-PRIVATE/);
	h.change();
	assert.doesNotMatch(h.view.render(90).join("\n"), /OLD-SCOPE-PRIVATE/);
	await tick();
	assert.equal(h.closes(), 1);
	h.view.render(90); h.view.handleInput("\r");
	await tick();
	assert.equal(h.closes(), 1, "do not close a replacement UI twice");
});

test("scope changes block new detail reads even before the next render", async () => {
	let reads = 0;
	const h = harness([{ id: "task", label: "Task", detail: () => { reads++; return "PRIVATE-DETAIL"; } }]);
	h.change();
	h.view.handleInput("\r");
	await tick();
	assert.equal(reads, 0);
	assert.equal(h.closes(), 1);
});

test("a late async detail cannot appear after the scope changes", async () => {
	let finish!: (text: string) => void;
	const pending = new Promise<string>((resolve) => { finish = resolve; });
	const h = harness([{ id: "task", label: "Task", detail: () => pending }]);
	h.view.handleInput("\r"); await tick();
	h.change(); finish("PRIVATE-LATE-DETAIL"); await tick();
	assert.doesNotMatch(h.view.render(90).join("\n"), /PRIVATE-LATE|OLD-SCOPE/);
	assert.equal(h.closes(), 1);
});

test("public scope guard allows normal appends, but permanently invalidates a sibling branch or session", () => {
	let session = "s1", leaf = "a";
	let path = [{ id: "a" }];
	let scans = 0;
	const ctx: any = { cwd: "/fixture", sessionManager: { getSessionId: () => session, getLeafId: () => leaf, getBranch: () => { scans++; return path; }, getEntries: () => { throw new Error("no session scan"); } } };
	const current = subagentViewScopeGuard(ctx);
	assert.equal(current(), true); assert.equal(scans, 0);
	leaf = "b"; path = [{ id: "a" }, { id: "b" }];
	assert.equal(current(), true, "an ordinary same-branch message does not close the view");
	assert.equal(current(), true); assert.equal(scans, 1, "same leaf needs no repeated ancestry scan");
	leaf = "c"; path = [{ id: "a" }, { id: "c" }];
	assert.equal(current(), false);
	leaf = "b"; path = [{ id: "a" }, { id: "b" }];
	assert.equal(current(), false, "an expired view cannot resurrect");
	const newView = subagentViewScopeGuard(ctx); session = "s2";
	assert.equal(newView(), false);
});

test("public scope guard fails closed on a disposed context", () => {
	const current = subagentViewScopeGuard({ sessionManager: { getSessionId: () => { throw new Error("disposed"); } } } as any);
	assert.equal(current(), false);
});

test("narrow task rows wrap rather than silently cut off model/thinking/status", () => {
	const label = "Review notification races — 后台检查 · project:worker · offline-demo/gpt-6.1-sol-demo · thinking:high · completed";
	const view = new ReadOnlySubagentView({ title: "Tasks", summary: "Select a task", tasks: [{ id: "hidden-task-id", label, detail: () => "detail" }] }, () => 30, () => undefined, () => undefined);
	const text = view.render(60).join("\n");
	assert.match(text, /gpt-6\.1-sol-demo/);
	assert.match(text, /thinking:high/);
	assert.match(text, /completed/);
	assert.doesNotMatch(text, /hidden-task-id/);
});

test("read-only views do not emit C1 OSC/CSI payloads", () => {
	const view = new ReadOnlySubagentView({ title: "Title", summary: "visible\u009b2J\u009d52;c;C1-SECRET\x07tail" }, () => 20, () => undefined, () => undefined);
	const text = view.render(100).join("\n");
	assert.doesNotMatch(text, /C1-SECRET|\u009b|\u009d/);
	assert.match(text, /visibletail/);
});
