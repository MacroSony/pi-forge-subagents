import type { BackgroundTaskResult } from "../runtime/background-tasks.ts";
import { getSubagentUsageReceipts, type ForgeSubagentUsageReceipt } from "./receipts.ts";
import { plainSubagentText } from "../ui/plain-text.ts";

type Usage = ForgeSubagentUsageReceipt["usage"];
interface UnknownRecord { taskId?: string }
const QUICK_TASK_LIMIT = 12;
const legacyIdentity = (id: string) => /^[a-f0-9]{32,}$/i.test(id) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id);

/** Only session/branch entries supplied by the caller are inspected; never native tool usage. */
function unknownRecords(entries: readonly unknown[]): UnknownRecord[] {
	return entries.flatMap((entry): UnknownRecord[] => {
		if (!record(entry) || !record(entry.message)) return [];
		const message = entry.message;
		if (message.role !== "toolResult") return [];
		const details = record(message.details) ? message.details : {};
		if (details.usageCredited === false || getSubagentUsageReceipts([entry]).length) return [];
		// A rejected plan/approval or a background launch is not a completed usage record.
		if (!details.response && !details.forgeNestedUsage && !details.forgeSubagentUsage) return [];
		if (message.toolName !== "forge_subagent" && message.toolName !== "forge_subagent_task" && !details.forgeNestedUsage && !details.forgeSubagentUsage) return [];
		const task = record(details.task) ? details.task : undefined;
		const id = task?.id ?? details.runId;
		return [{ ...(typeof id === "string" && id ? { taskId: id } : {}) }];
	});
}

/** Never truncate canonical handles, regardless of counter length. Legacy aliases are local to the explicitly selected scope. */
export function usageTaskLabels(ids: readonly string[]): Map<string, string> {
	const unique = [...new Set(ids)];
	const labels = new Map(unique.filter((id) => !legacyIdentity(id)).map((id) => [id, id]));
	const used = new Set(labels.values());
	for (const id of unique.filter(legacyIdentity).sort()) {
		const stem = `legacy-${id.slice(0, 8)}`;
		let counter = 1;
		while (used.has(`${stem}-${counter}`)) counter++;
		const label = `${stem}-${counter}`;
		labels.set(id, label); used.add(label);
	}
	return labels;
}
export function shortUsageTaskId(id: string, ids: readonly string[] = [id]): string { return usageTaskLabels([...ids, id]).get(id)!; }

export function recordedUsageTaskIds(entries: readonly unknown[]): string[] {
	return [...new Set([...getSubagentUsageReceipts(entries).map((r) => r.taskId), ...unknownRecords(entries).flatMap((r) => r.taskId ? [r.taskId] : [])])];
}

/** Snapshot an already branch-gated, read-only background result; no mutation or claim. */
function backgroundReceipt(result: BackgroundTaskResult): ForgeSubagentUsageReceipt | undefined {
	const response = result.response;
	if (!response) return undefined;
	try { return getSubagentUsageReceipts([{ type: "message", message: { role: "toolResult", details: {
		forgeSubagentUsage: { schemaVersion: 1, runs: [{
			runId: response.runId, taskId: result.task.id, profileId: result.task.profileId,
			model: response.model, status: response.status, usage: response.usage,
		}] },
	} } }])[0]; } catch { return undefined; }
}

export type SubagentUsageScope = "session" | "branch";

interface DisplayMetadata {
	title?: string;
	thinkingLevel?: string;
	model?: { provider: string; id: string };
}
interface DisplaySource extends DisplayMetadata {
	taskId?: string;
	responseRunId?: string;
	preparedRunId?: string;
	executionRunId?: string;
	declaredRunId?: string;
	localRuns?: readonly string[];
	linkedRuns?: readonly string[];
	linkedExecutionRuns?: readonly string[];
}
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const displayStatuses = new Set(["starting", "running", "completed", "failed", "cancelled", "timed-out", "limit-reached"]);
function displayField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) ? value : undefined;
}
/** UI whitelist only: no arbitrary producer fields, prompt, output, cost or current profile defaults. */
function displayTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = plainSubagentText(value).replace(/[\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
	const chars = Array.from(text);
	return chars.length ? chars.length <= 100 ? text : `${chars.slice(0, 97).join("")}...` : undefined;
}
function displaySource(task: unknown, execution: unknown, response: unknown, declaredRunId?: unknown): DisplaySource {
	const t = record(task) ? task : undefined;
	const e = record(execution) ? execution : undefined;
	const r = record(response) ? response : undefined;
	const provider = record(e?.model) ? displayField(e.model.provider) : undefined;
	const id = record(e?.model) ? displayField(e.model.id) : undefined;
	return {
		taskId: displayField(t?.id), responseRunId: displayField(r?.runId), preparedRunId: displayField(r?.preparedRunId),
		executionRunId: displayField(e?.runId), declaredRunId: displayField(declaredRunId),
		title: displayTitle(typeof task === "string" ? task : t?.title),
		...(provider && id ? { model: { provider, id }, ...(typeof e?.thinkingLevel === "string" && thinkingLevels.has(e.thinkingLevel) ? { thinkingLevel: e.thinkingLevel } : {}) } : {}),
	};
}
function recordedDisplaySources(entries: readonly unknown[]): DisplaySource[] {
	return entries.flatMap((entry): DisplaySource[] => {
		if (!record(entry) || entry.type !== "message" || !record(entry.message) || entry.message.role !== "toolResult") return [];
		const message = entry.message;
		if (message.toolName !== "forge_subagent" && message.toolName !== "forge_subagent_task") return [];
		if (!record(message.details)) return [];
		const d = message.details;
		const task = record(d.task) ? d.task : undefined;
		const executions = [d.execution, task?.execution].filter(record);
		const localRows = getSubagentUsageReceipts([entry]);
		return (executions.length ? executions : [undefined]).map((execution) => {
			const source = displaySource(d.task, execution, d.response, d.runId);
			// Direct/wrapped replays may retain different task aliases for the same real run.
			// Only exact identities in this entry substantiate that link, never a prefix/context handle.
			const linkedExecutionRuns = localRows.filter((r) => source.executionRunId === r.runId || source.executionRunId === r.taskId).map((r) => r.runId);
			const linkedRuns = localRows.filter((r) => linkedExecutionRuns.includes(r.runId) || source.taskId === r.taskId || source.declaredRunId === r.runId || source.declaredRunId === r.taskId).map((r) => r.runId);
			return { ...source, ...(localRows.length ? { localRuns: localRows.map((r) => r.runId), linkedRuns, linkedExecutionRuns } : {}) };
		});
	});
}
function sameModel(a: NonNullable<DisplayMetadata["model"]>, b: NonNullable<DisplayMetadata["model"]>): boolean {
	return a.provider === b.provider && a.id === b.id;
}
function matchesRun(source: DisplaySource, row: ForgeSubagentUsageReceipt): boolean {
	if (source.localRuns && !source.localRuns.includes(row.runId)) return false;
	// A reported response identity is stronger than a reused task/context display handle.
	if (source.responseRunId) return source.responseRunId === row.runId;
	if (source.linkedRuns?.includes(row.runId)) return true;
	const identity = source.executionRunId ?? source.taskId ?? source.declaredRunId;
	return identity !== undefined && (identity === row.runId || identity === row.taskId);
}
function sourceMetadata(source: DisplaySource, row?: ForgeSubagentUsageReceipt, taskId?: string): DisplayMetadata {
	const executionMatches = source.executionRunId !== undefined && (row
		? source.executionRunId === row.runId || source.executionRunId === row.taskId || source.linkedExecutionRuns?.includes(row.runId) || (source.responseRunId === row.runId && (source.executionRunId === source.preparedRunId || source.executionRunId === source.taskId))
		: source.executionRunId === taskId);
	const modelMatches = source.model && (!row || sameModel(source.model, row.model));
	return { title: source.title, ...(executionMatches && modelMatches ? { model: source.model, thinkingLevel: source.thinkingLevel } : {}) };
}
function uniqueField(values: readonly (string | undefined)[]): string | undefined {
	const known = [...new Set(values.filter((v): v is string => v !== undefined))];
	return known.length === 1 ? known[0] : undefined; // conflicting metadata is unknown, not last-writer-wins
}
function mergedMetadata(parts: readonly DisplayMetadata[]): DisplayMetadata {
	return { title: uniqueField(parts.map((p) => p.title)), thinkingLevel: uniqueField(parts.map((p) => p.thinkingLevel)) };
}
function metadataByRun(rows: readonly ForgeSubagentUsageReceipt[], sources: readonly DisplaySource[]): Map<string, DisplayMetadata> {
	const parts = new Map<string, DisplayMetadata[]>();
	for (const source of sources) {
		const matches = rows.filter((row) => matchesRun(source, row));
		if (matches.length !== 1) continue; // reused continuation handle is not an invocation identity
		const row = matches[0]!;
		const list = parts.get(row.runId) ?? [];
		list.push(sourceMetadata(source, row)); parts.set(row.runId, list);
	}
	return new Map([...parts].map(([id, values]) => [id, mergedMetadata(values)]));
}

/** Navigation retains scoped identities internally, but human labels contain no handles. No output or claims. */
export function subagentUsageTasks(entries: readonly unknown[], background: readonly BackgroundTaskResult[] = []): { id: string; label: string }[] {
	const receipts = getSubagentUsageReceipts(entries);
	const pending = background.filter((r) => !r.task.collected);
	const ids = [...new Set([...recordedUsageTaskIds(entries), ...pending.map((r) => r.task.id)])];
	// ALL supplied background results were branch-gated by the caller. Collected snapshots
	// enrich display only: they do not add task identities, pending rows or any accounting.
	const sources = [...recordedDisplaySources(entries), ...background.map((r) => displaySource(r.task, r.task.execution, r.response))];
	const metadata = metadataByRun(receipts, sources);
	return ids.map((id) => {
		const rows = receipts.filter((r) => r.taskId === id);
		const live = pending.find((r) => r.task.id === id)?.task;
		const otherParts = rows.length ? [] : sources.filter((s) => (s.taskId ?? s.executionRunId ?? s.declaredRunId) === id).map((s) => sourceMetadata(s, undefined, id));
		const display = rows.length ? rows.map((r) => metadata.get(r.runId) ?? {}) : [mergedMetadata(otherParts)];
		const titles = [...new Set(display.flatMap((d) => d.title ? [d.title] : []))];
		const title = displayTitle(titles.join(" / "));
		const models = rows.map((r) => `${displayField(r.model.provider) ?? "provider unknown"}/${displayField(r.model.id) ?? "model unknown"}`);
		if (!rows.length) models.push(...otherParts.flatMap((d) => d.model ? [`${d.model.provider}/${d.model.id}`] : []));
		const profile = displayField(live?.profileId) ?? rows.map((r) => displayField(r.profileId)).find((p) => p !== undefined) ?? "profile unknown";
		const liveStatus = typeof live?.status === "string" && displayStatuses.has(live.status) ? live.status : undefined;
		const status = liveStatus ?? ([...new Set(rows.map((r) => r.status))].join(", ") || "coverage unknown");
		const thinking = [...new Set(display.map((d) => d.thinkingLevel ?? "unknown"))].join(", ");
		return { id, label: `${title ? `${title} · ` : ""}${profile} · ${[...new Set(models)].join(", ") || "model unknown"} · thinking:${thinking} · ${status}` };
	});
}

export function renderSubagentUsageReport(entries: readonly unknown[], background: readonly BackgroundTaskResult[] = [], taskFragment?: string, scope: SubagentUsageScope = "session"): string {
	const scopeText = scope === "branch" ? "current branch" : "session";
	let receipts = getSubagentUsageReceipts(entries);
	let unknown = unknownRecords(entries);
	let pending = background.filter((r) => !r.task.collected);
	const recordedIds = [...new Set([...receipts.map((r) => r.taskId), ...unknown.flatMap((r) => r.taskId ? [r.taskId] : [])])];
	const ids = [...new Set([...recordedIds, ...pending.map((r) => r.task.id)])];
	const labels = usageTaskLabels(ids);
	const label = (id: string) => labels.get(id)!;
	if (taskFragment) {
		const exact = ids.filter((id) => id === taskFragment || label(id) === taskFragment);
		const matches = exact.length ? exact : ids.filter((id) => id.startsWith(taskFragment) || label(id).startsWith(taskFragment));
		if (matches.length > 1) throw new Error("Ambiguous task ID; use a longer task ID prefix or the complete displayed alias.");
		if (!matches.length) return `No recorded usage or pending task for that ID in the ${scopeText}. Historical coverage may be unknown.`;
		const id = matches[0]!;
		receipts = receipts.filter((r) => r.taskId === id);
		unknown = unknown.filter((r) => r.taskId === id);
		pending = pending.filter((r) => r.task.id === id);
	}
	const lines = [
		`Subagent usage — ${scope === "branch" ? "current branch only" : "session (all branches)"} (recorded receipts)`,
		"Model attribution: selected execution model; physical provider routing: unknown.",
		"Costs are estimates, not billing. Native parent/tool usage is excluded.",
		"Historical wrapped results without receipts: unknown; not inferred or backfilled.",
		"",
		"Recorded totals by provider/model:",
	];
	const models = group(receipts, (r) => JSON.stringify([r.model.provider, r.model.id]));
	if (!models.size) lines.push(`  No recorded subagent usage in this ${scope === "branch" ? "branch" : "session"}.`);
	for (const rows of models.values()) lines.push(`  ${rows[0]!.model.provider}/${rows[0]!.model.id}: ${summarize(rows.map((r) => r.usage))}`);
	// Keep this warning with the totals so the compact UI summary cannot drop unknown history.
	if (unknown.length) lines.push(`  Historical/unreadable records: ${unknown.length}; requests/input/output/cache/estimated cost: unknown (excluded from totals).`);
	if (taskFragment) {
		const display = subagentUsageTasks(entries, background).find((task) => task.id === receipts[0]?.taskId || task.id === unknown[0]?.taskId || task.id === pending[0]?.task.id);
		if (display) lines.push("", `Display metadata (recorded/branch-gated snapshot): ${display.label}`);
		lines.push("", "Recorded task details:");
		const tasks = group(receipts, (r) => JSON.stringify([r.taskId, r.model.provider, r.model.id]));
		if (!tasks.size) lines.push("  None.");
		for (const rows of tasks.values()) {
			const r = rows[0]!;
			lines.push(`  ${label(r.taskId)}${r.profileId ? ` profile:${r.profileId}` : ""} ${r.model.provider}/${r.model.id} [${[...new Set(rows.map((r) => r.status))].join(", ")}] runs:${rows.length}: ${summarize(rows.map((r) => r.usage))}`);
		}
	} else {
		const shown = recordedIds.slice(-QUICK_TASK_LIMIT);
		lines.push("", `Task index (${recordedIds.length}${recordedIds.length > shown.length ? `; latest ${shown.length}, ${recordedIds.length - shown.length} older omitted` : ""}): ${shown.map(label).join(", ") || "None."}`,
			`Details: /forge-agent usage <id>${scope === "branch" ? " --branch" : ""} (or /forge subagent usage); completion lists ${scopeText} IDs.`);
	}
	if (unknown.length && taskFragment) lines.push(...unknown.flatMap((r) => r.taskId ? [`  ${label(r.taskId)}: unknown coverage.`] : []));
	if (ids.some(legacyIdentity)) lines.push(`Legacy UUID/SHA task IDs use distinct legacy-* display aliases, resolved only within this ${scope === "branch" ? "branch" : "session"}.`);
	const running = pending.filter((r) => r.task.status === "starting" || r.task.status === "running");
	const ready = pending.filter((r) => r.task.status !== "starting" && r.task.status !== "running");
	const visible = (rows: BackgroundTaskResult[]) => taskFragment ? rows : rows.slice(-QUICK_TASK_LIMIT);
	lines.push("", "Background running (not in recorded totals; usage unknown while running):");
	lines.push(...(running.length ? visible(running).map((r) => `  ${label(r.task.id)} profile:${r.task.profileId} [${r.task.status}]${r.task.execution ? ` ${r.task.execution.model.provider}/${r.task.execution.model.id} thinking:${r.task.execution.thinkingLevel ?? "unknown"}` : " model/thinking:unknown"}`) : ["  None."]));
	if (visible(running).length < running.length) lines.push(`  ${running.length - QUICK_TASK_LIMIT} more running tasks; use completion and usage <id>.`);
	lines.push("", "Background completed/uncollected (read-only; not added to recorded totals):");
	const recordedRuns = new Set(receipts.map((r) => r.runId));
	lines.push(...(ready.length ? visible(ready).map((r) => {
		const receipt = backgroundReceipt(r);
		const coverage = receipt?.usage.requests;
		const complete = coverage && coverage.usageKnown === coverage.total && coverage.cacheKnown === coverage.total;
		const quick = `usage available${complete ? "" : " (coverage incomplete/unknown)"}; usage <id> for detail`;
		const usage = receipt ? `${receipt.model.provider}/${receipt.model.id}: ${taskFragment ? summarize([receipt.usage]) : quick}${recordedRuns.has(receipt.runId) ? " (already recorded; not counted again)" : ""}` : "selected model/requests/input/output/cache/estimated cost: unknown";
		return `  ${label(r.task.id)} profile:${r.task.profileId} [${r.task.status}]: ${usage}`;
	}) : ["  None."]));
	if (visible(ready).length < ready.length) lines.push(`  ${ready.length - QUICK_TASK_LIMIT} more uncollected tasks; use completion and usage <id>.`);
	lines.push("", "Live/pending output and usage remain launch-branch gated; return to the launch branch for inaccessible tasks.", "Viewing does not collect results, claim usage, or start a model.");
	return lines.join("\n");
}

function summarize(usages: readonly Usage[]): string {
	const total = sum(usages.map((u) => u.requests?.total));
	const usageKnown = sum(usages.map((u) => u.requests?.usageKnown));
	const cacheKnown = sum(usages.map((u) => u.requests?.cacheKnown));
	const complete = total !== undefined && usageKnown === total;
	const cacheComplete = total !== undefined && cacheKnown === total;
	const coverage = (n: number | undefined) => `${n ?? "unknown"}/${total ?? "unknown"}`;
	const tokens = (values: (number | undefined)[]) => sum(values) ?? "unknown";
	const currencies = [...new Set(usages.flatMap((u) => u.cost ? [u.cost.currency] : []))];
	const amount = currencies.length === 1 ? sum(usages.map((u) => u.cost?.amount)) : undefined;
	const cost = amount === undefined ? "unknown" : `${currencies[0]} ${amount.toFixed(6)}`;
	const partial = complete && cacheComplete ? "" : `; known subtotals only, remainder unknown; usage coverage:${coverage(usageKnown)} cache coverage:${coverage(cacheKnown)}`;
	return `requests:${total ?? "unknown"} input:${tokens(usages.map((u) => u.tokens?.input))} output:${tokens(usages.map((u) => u.tokens?.output))} cacheRead:${tokens(usages.map((u) => u.tokens?.cacheRead))} cacheWrite:${tokens(usages.map((u) => u.tokens?.cacheWrite))} estimated cost:${cost}${partial}`;
}

function sum(values: readonly (number | undefined)[]): number | undefined {
	if (values.some((v) => v === undefined || !Number.isFinite(v) || v < 0)) return undefined;
	const n = (values as number[]).reduce((a, b) => a + b, 0);
	return Number.isFinite(n) && n <= Number.MAX_SAFE_INTEGER ? n : undefined;
}
function group<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
	const result = new Map<string, T[]>();
	for (const value of values) { const k = key(value); const rows = result.get(k) ?? []; rows.push(value); result.set(k, rows); }
	return result;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
