import assert from "node:assert/strict";
import test from "node:test";
import { renderSubagentUsageReport, subagentUsageTasks } from "../src/usage/report.ts";

const execution = { model: { provider: "fixture", id: "selected-model" }, thinkingLevel: "high", backendId: "pi-inprocess", runId: "t-parent-1", mode: "foreground", contextMode: "one-shot" };
const usage = { requests: { total: 1, usageKnown: 1, cacheKnown: 1 }, tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 } };
const receipt = { runId: "t-parent-1", taskId: "t-parent-1", profileId: "project:worker", model: execution.model, status: "completed", usage };
function entry(details: Record<string, unknown>) {
	return { type: "message", message: { role: "toolResult", toolName: "forge_subagent", details: { ...details, forgeSubagentUsage: { schemaVersion: 1, runs: [receipt] } } } };
}

test("recorded foreground metadata keeps task title/thinking after session replay without current profiles", () => {
	const entries = JSON.parse(JSON.stringify([entry({ task: "Review notification races", execution })]));
	const before = JSON.stringify(entries);
	const rows = subagentUsageTasks(entries);
	assert.equal(rows.length, 1);
	assert.match(rows[0]!.label, /Review notification races/);
	assert.match(rows[0]!.label, /selected-model.*thinking:high/);
	assert.doesNotMatch(rows[0]!.label, /t-parent-1/);
	assert.equal(JSON.stringify(entries), before);
});

test("recorded background result preserves its safe title/thinking when the live manager no longer exists", () => {
	const entries = [entry({ action: "result", task: { id: "t-parent-1", title: "Review accounting", profileId: "project:worker", status: "completed", collected: true, execution: { ...execution, mode: "background" } } })];
	const label = subagentUsageTasks(entries)[0]!.label;
	assert.match(label, /Review accounting/);
	assert.match(label, /thinking:high/);
});

test("a collected live snapshot can inform a recorded task label without being counted as pending usage", () => {
	const entries = [entry({})];
	const background: any[] = [{ task: { id: "t-parent-1", title: "Already collected task", profileId: "project:worker", status: "completed", collected: true, execution }, response: { runId: "t-parent-1", model: execution.model, status: "completed", usage }, creditUsage: false }];
	assert.match(subagentUsageTasks(entries, background)[0]!.label, /Already collected task.*thinking:high/);
	assert.equal(renderSubagentUsageReport(entries, background), renderSubagentUsageReport(entries));
});

test("legacy recorded receipt still labels missing thinking as unknown rather than inventing settings", () => {
	assert.match(subagentUsageTasks([entry({})])[0]!.label, /thinking:unknown/);
});
