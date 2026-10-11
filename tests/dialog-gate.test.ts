import assert from "node:assert/strict";
import test from "node:test";
import { trySubagentView, withSubagentDialog } from "../src/ui/dialog-gate.ts";
import { createForgeAgentCommandHandler } from "../src/command/forge-agent.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("dialogs serialize per UI and views never steal active or queued approvals", async () => {
	const ui = {};
	const hold = deferred();
	const started: string[] = [];
	const first = withSubagentDialog(ui, async () => { started.push("first"); await hold.promise; });
	const second = withSubagentDialog(ui, async () => { started.push("second"); });
	assert.deepEqual(await trySubagentView(ui, async () => { throw new Error("must not open"); }), { opened: false });
	assert.deepEqual(started, ["first"]);
	hold.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(started, ["first", "second"]);
	assert.deepEqual(await trySubagentView(ui, async () => "ready"), { opened: true, value: "ready" });
});

test("a view reserves synchronously and later approvals wait without replacing it", async () => {
	const ui = {};
	const hold = deferred();
	let approvals = 0;
	const view = trySubagentView(ui, async () => { await hold.promise; return "view closed"; });
	const approval = withSubagentDialog(ui, async () => { approvals++; });
	assert.deepEqual(await trySubagentView(ui, async () => "second view"), { opened: false });
	assert.equal(approvals, 0);
	hold.resolve();
	assert.deepEqual(await view, { opened: true, value: "view closed" });
	await approval;
	assert.equal(approvals, 1);
});

test("dialog state does not block unrelated parent UIs", async () => {
	const hold = deferred();
	const first = withSubagentDialog({}, async () => hold.promise);
	assert.deepEqual(await trySubagentView({}, async () => 7), { opened: true, value: 7 });
	hold.resolve();
	await first;
});

test("approval rejection releases the gate and does not poison queued work", async () => {
	const ui = {};
	const failed = withSubagentDialog(ui, async () => { throw new Error("cancelled approval"); });
	const next = withSubagentDialog(ui, async () => "next approval");
	await assert.rejects(failed, /cancelled approval/);
	assert.equal(await next, "next approval");
	assert.deepEqual(await trySubagentView(ui, async () => undefined), { opened: true, value: undefined });
});

test("legacy info commands cannot replace an outstanding subagent approval", async () => {
	let editorCalls = 0;
	const ui = { editor: async () => { editorCalls++; }, notify: () => undefined };
	const hold = deferred();
	const approval = withSubagentDialog(ui, async () => hold.promise);
	const ctx = { hasUI: true, ui } as any;
	const command = createForgeAgentCommandHandler({} as any, () => undefined)("help", ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const beforeApprovalClosed = editorCalls;
	hold.resolve();
	await Promise.all([approval, command]);
	assert.equal(beforeApprovalClosed, 0, "legacy showText must share dialog ownership");
	assert.equal(editorCalls, 1, "the queued read-only information remains available");
});

test("view cancellation or rendering failure releases its reservation", async () => {
	const ui = {};
	await assert.rejects(trySubagentView(ui, async () => { throw new Error("view renderer failed"); }), /view renderer failed/);
	assert.deepEqual(await trySubagentView(ui, async () => undefined), { opened: true, value: undefined });
});
