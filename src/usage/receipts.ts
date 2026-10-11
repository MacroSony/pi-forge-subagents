import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseForgeNestedUsage, type ForgeNestedUsage } from "@zihanw/pi-forge/subagent";
import type { RunUsage } from "@zihanw/pi-subagent-runtime";
import { mapForgeSubagentUsage } from "../tool/forge-subagent-usage.ts";

export interface ForgeSubagentUsageReceipt {
	/** Actual response.runId, not the prepared id or retained continuation handle. */
	runId: string;
	/** Complete canonical task identity. Presentation/shortening belongs to the UI. */
	taskId: string;
	profileId?: string;
	/** Selected execution model. This is NOT physical-route attribution. */
	model: { provider: string; id: string };
	status: "completed" | "failed" | "cancelled" | "timed-out" | "limit-reached";
	/** One invocation's delta, never a retained session's lifetime usage. */
	usage: RunUsage;
}
export interface ForgeSubagentUsageEnvelope {
	schemaVersion: 1;
	runs: ForgeSubagentUsageReceipt[];
}
const KEY = "forgeSubagentUsage";
const MAX_PENDING_SCOPES = 1024;
const MAX_PENDING_RUNS = 8192;
const MAX_RECEIPTS = 8192;
const statuses = new Set(["completed", "failed", "cancelled", "timed-out", "limit-reached"]);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Reconstruct only accounting fields; never copy output/prompt/arbitrary producer keys. */
function usageOf(v: unknown): RunUsage | undefined {
	if (!record(v)) return;
	const usage: RunUsage = {};
	if (v.tokens !== undefined) {
		const t = v.tokens;
		if (!record(t) || !count(t.input) || !count(t.output) || !count(t.total)) return;
		const paired = t.cacheRead !== undefined || t.cacheWrite !== undefined;
		if (paired && (!count(t.cacheRead) || !count(t.cacheWrite))) return;
		const sum = t.input + t.output + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
		if (!Number.isSafeInteger(sum) || sum !== t.total) return;
		usage.tokens = { input: t.input, output: t.output, total: t.total, ...(paired ? { cacheRead: t.cacheRead, cacheWrite: t.cacheWrite } : {}) };
	}
	if (v.requests !== undefined) {
		const r = v.requests;
		if (!record(r) || !count(r.total) || !count(r.cacheKnown) || r.cacheKnown > r.total || (r.usageKnown !== undefined && (!count(r.usageKnown) || r.usageKnown > r.total))) return;
		usage.requests = { total: r.total, cacheKnown: r.cacheKnown, ...(r.usageKnown !== undefined ? { usageKnown: r.usageKnown } : {}) };
	}
	if (v.cost !== undefined) {
		const c = v.cost;
		if (!record(c) || !amount(c.amount) || typeof c.currency !== "string" || !/^[A-Z]{3}$/.test(c.currency)) return;
		usage.cost = { amount: c.amount, currency: c.currency };
		if (c.breakdown !== undefined) {
			const b = c.breakdown;
			if (!record(b) || ![b.input, b.output, b.cacheRead, b.cacheWrite].every(amount)) return;
			usage.cost.breakdown = { input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite: b.cacheWrite };
		}
	}
	if (!usage.tokens && !usage.cost && !usage.requests) return;
	if (usage.requests && usage.tokens && !mapForgeSubagentUsage(usage).nested) return;
	return usage;
}
function receiptOf(v: unknown): ForgeSubagentUsageReceipt | undefined {
	if (!record(v) || !text(v.runId) || !text(v.taskId) || !record(v.model) || !text(v.model.provider) || !text(v.model.id) || !statuses.has(v.status)) return;
	const usage = usageOf(v.usage);
	if (!usage) return;
	return { runId: v.runId, taskId: v.taskId, ...(text(v.profileId) ? { profileId: v.profileId } : {}), model: { provider: v.model.provider, id: v.model.id }, status: v.status, usage };
}
function envelopeOf(v: unknown): ForgeSubagentUsageReceipt[] {
	if (!record(v) || v.schemaVersion !== 1 || !Array.isArray(v.runs)) throw new Error("Unsupported or invalid Forge subagent receipt envelope");
	if (v.runs.length > MAX_RECEIPTS) throw new Error("Forge subagent receipt envelope exceeds safe limit");
	const runs = v.runs.map(receiptOf);
	// Reject the entire envelope rather than manufacture a partial total.
	if (runs.some((r) => !r)) throw new Error("Invalid Forge subagent receipt envelope");
	return runs as ForgeSubagentUsageReceipt[];
}
function directOf(message: Record<string, any>): ForgeSubagentUsageReceipt | undefined {
	if (message.toolName !== "forge_subagent" && message.toolName !== "forge_subagent_task") return;
	const d = message.details;
	if (!record(d) || d.usageCredited === false || !record(d.response)) return;
	// Background inspection/launch/cancel never credits usage. Only result collection does.
	if (message.toolName === "forge_subagent_task" && (d.action !== "result" || d.usageCredited !== true)) return;
	const validated = usageOf(d.response.usage);
	if (!validated) return;
	const mapped = mapForgeSubagentUsage(validated);
	const nested = parseForgeNestedUsage(d.forgeNestedUsage);
	const t = validated.tokens;
	const c = validated.cost;
	// Credit proof is checked structurally, independent of JSON property order.
	// Old credited direct results may have no requests metadata: keep it unknown,
	// never manufacture requests from their native tool-result receipt.
	const native = message.usage;
	const nativeProof = t && record(native) && c?.currency === "USD" && c.breakdown && record(native.cost) &&
		[[native.input, t.input], [native.output, t.output], [native.cacheRead, t.cacheRead], [native.cacheWrite, t.cacheWrite], [native.totalTokens, t.total], [native.cost.total, c.amount], ...["input", "output", "cacheRead", "cacheWrite"].map((key) => [native.cost[key], (c.breakdown as any)[key]])].every(([a, b]) => a !== undefined && a === b);
	const nestedProof = nested && (mapped.nested
		? ["requests", "input", "output", "cacheRead", "cacheWrite"].every((key) => (nested as any)[key] === (mapped.nested as any)[key])
		: !validated.requests && t && nested.input === t.input && nested.output === t.output && (nested.cacheRead === undefined || (nested.cacheRead === t.cacheRead && nested.cacheWrite === t.cacheWrite)));
	const credited = d.usageCredited === true || nativeProof || nestedProof;
	if (!credited) return;
	return receiptOf({ runId: d.response.runId, taskId: d.task?.id ?? d.runId ?? d.response.preparedRunId ?? d.response.runId, profileId: d.task?.profileId ?? d.profileId, model: d.response.model, status: d.response.status, usage: d.response.usage });
}
function merge(runs: readonly ForgeSubagentUsageReceipt[]): ForgeSubagentUsageReceipt[] {
	const seen = new Map<string, ForgeSubagentUsageReceipt>();
	for (const run of runs) {
		const prior = seen.get(run.runId);
		if (prior && JSON.stringify([prior.model, prior.status, prior.usage]) !== JSON.stringify([run.model, run.status, run.usage])) throw new Error("Conflicting Forge subagent receipts for one response.runId");
		// Display labels can differ in direct legacy vs wrapped replay; they are not
		// accounting identity. Keep the first label and enrich a missing profile only.
		seen.set(run.runId, prior ? { ...prior, ...(!prior.profileId && run.profileId ? { profileId: run.profileId } : {}) } : run);
	}
	return [...seen.values()];
}
function runsOf(message: Record<string, any>): ForgeSubagentUsageReceipt[] {
	const d = message.details;
	if (record(d) && d.usageCredited === false) return [];
	if (record(d) && d[KEY] !== undefined) return envelopeOf(d[KEY]);
	const direct = directOf(message);
	return direct ? [direct] : [];
}
/** Read current-branch persisted entries. Never rewrites history or claims background results. */
export function getSubagentUsageReceipts(entries: readonly unknown[]): ForgeSubagentUsageReceipt[] {
	const runs: ForgeSubagentUsageReceipt[] = [];
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "message" || !record(entry.message) || entry.message.role !== "toolResult") continue;
		if (record(entry.message.details) && entry.message.details.forgeSubagentUsageError) throw new Error("Incomplete Forge subagent receipt accounting in recorded session");
		runs.push(...runsOf(entry.message));
	}
	return merge(runs);
}
function sameNested(a: ForgeNestedUsage, b: ForgeNestedUsage | undefined): boolean {
	return !!b && (["schemaVersion", "requests", "input", "output", "cacheRead", "cacheWrite"] as const).every((key) => a[key] === b[key]);
}
function aggregate(runs: readonly ForgeSubagentUsageReceipt[]): ForgeNestedUsage | undefined {
	const parts = runs.map((r) => mapForgeSubagentUsage(r.usage).nested);
	if (parts.some((p) => !p)) return; // no guessed request counts for legacy coverage
	const known = parts as ForgeNestedUsage[];
	const total: ForgeNestedUsage = { schemaVersion: 1, requests: 0, input: 0, output: 0 };
	const cacheKnown = known.every((p) => p.cacheRead !== undefined && p.cacheWrite !== undefined);
	if (cacheKnown) { total.cacheRead = 0; total.cacheWrite = 0; }
	for (const part of known) {
		for (const key of ["requests", "input", "output", ...(cacheKnown ? ["cacheRead", "cacheWrite"] : [])] as (keyof Omit<ForgeNestedUsage, "schemaVersion">)[]) {
			const value = (total[key] ?? 0) + (part[key] ?? 0);
			if (!count(value)) throw new Error("Forge subagent receipt aggregate overflow");
			total[key] = value;
		}
	}
	return total;
}
/** Optional-only tool_result bridge. Details only: native usage belongs exclusively to Pi. */
export function registerForgeSubagentUsageBridge(pi: ExtensionAPI): () => void {
	const pending = new Map<string, ForgeSubagentUsageReceipt[]>();
	// Object references emitted by child hooks prove forwarding provenance. Mere
	// numerical equality of an unrelated producer's summary does not prove coverage.
	const pendingViews = new Map<string, Set<ForgeNestedUsage>>();
	const credited = new Map<string, ForgeSubagentUsageReceipt>();
	let sessionId: string | undefined;
	let generation = 0;
	// In-flight identities only (no receipts/prompts). Retain their generation across
	// a switch so late old-session hooks cannot seed new-session pending receipts.
	const inFlight = new Map<string, { generation: number; remaining: number; ambiguous: boolean }>();
	let inFlightCount = 0;
	let poisoned = false;
	let disposed = false;
	const clear = () => { pending.clear(); pendingViews.clear(); credited.clear(); poisoned = false; sessionId = undefined; generation++; };
	const ensureSession = (ctx: any) => {
		const currentId = ctx.sessionManager.getSessionId();
		if (sessionId !== currentId) {
			clear(); sessionId = currentId;
			try {
				// Public, read-only branch replay prevents a reopened credited run from
				// being attributed again; never write through sessionManager.
				const recorded = typeof ctx.sessionManager.getBranch === "function" ? getSubagentUsageReceipts(ctx.sessionManager.getBranch()) : [];
				if (recorded.length > MAX_RECEIPTS) throw new Error("Forge subagent receipt bridge state exceeded safe limits");
				for (const run of recorded) credited.set(run.runId, run);
			} catch { poisoned = true; }
		}
	};
	const off: (() => void)[] = [];
	const listen = (event: string, handler: (...args: any[]) => any) => {
		const unsubscribe = (pi.on as any)(event, handler);
		if (typeof unsubscribe === "function") off.push(unsubscribe);
	};
	// before_switch / before_fork are cancellable intentions, not invalidations.
	for (const event of ["session_start", "session_tree", "session_shutdown"]) listen(event, clear);
	listen("tool_call", (event: Record<string, any>, ctx: any) => {
		if (disposed) return;
		ensureSession(ctx);
		if (inFlightCount >= MAX_PENDING_RUNS) { poisoned = true; return; }
		const prior = inFlight.get(event.toolCallId);
		if (prior) {
			// tool_result exposes no originating-session identity. Never overwrite an
			// old generation with the new call: either result could be the late one.
			prior.remaining++; prior.ambiguous = true;
		} else inFlight.set(event.toolCallId, { generation, remaining: 1, ambiguous: false });
		inFlightCount++;
	});
	listen("tool_result", (event: Record<string, any>, ctx: any) => {
		if (disposed) return;
		ensureSession(ctx);
		const started = inFlight.get(event.toolCallId);
		if (started) {
			started.remaining--; inFlightCount--;
			if (started.remaining === 0) inFlight.delete(event.toolCallId);
		}
		if (started && !started.ambiguous && started.generation !== generation) return;
		const d = record(event.details) ? event.details : {};
		try {
			if (started?.ambiguous) throw new Error("Ambiguous Forge subagent toolCallId reused while an earlier call is still in flight");
			if (poisoned) throw new Error("Forge subagent receipt bridge accounting is incomplete");
			const own = runsOf(event);
			const children = pending.get(event.toolCallId) ?? [];
			const childViews = pendingViews.get(event.toolCallId);
			pending.delete(event.toolCallId); pendingViews.delete(event.toolCallId);
			const runs = merge([...own, ...children]);
			if (runs.length === 0) return;
			if (runs.length > MAX_RECEIPTS) throw new Error("Forge subagent receipt envelope exceeds safe limit");
			if (d.forgeNestedUsage !== undefined) {
				const existing = parseForgeNestedUsage(d.forgeNestedUsage);
				// An explicit envelope/direct credited receipt can substantiate its own
				// aggregate. A wrapper without identity may only forward a witnessed
				// child view; otherwise overlap/independence cannot be established.
				const forwarded = childViews?.has(d.forgeNestedUsage) === true;
				const ownCovered = existing && own.length > 0 && (sameNested(existing, aggregate(own)) || sameNested(existing, aggregate(runs)));
				if (!existing || (!forwarded && !ownCovered)) throw new Error("Unproven overlap between wrapper forgeNestedUsage and child receipts");
			}
			// Nested results are not persisted. Commit dedupe only at the outermost
			// result, after parallel sibling receipts have merged by actual runId.
			const root = !event.parentToolCallId;
			if (root) {
				merge([...credited.values(), ...runs]); // conflicting replay fails explicitly
				const newCount = runs.filter((r) => !credited.has(r.runId)).length;
				if (credited.size + newCount > MAX_RECEIPTS) throw new Error("Forge subagent receipt bridge state exceeded safe limits");
			}
			const nested = aggregate(root ? runs.filter((r) => !credited.has(r.runId)) : runs);
			if (event.parentToolCallId) {
				pending.set(event.parentToolCallId, merge([...(pending.get(event.parentToolCallId) ?? []), ...runs]));
				if (nested) {
					const views = pendingViews.get(event.parentToolCallId) ?? new Set<ForgeNestedUsage>();
					views.add(nested); pendingViews.set(event.parentToolCallId, views);
				}
				const size = [...pending.values()].reduce((n, rs) => n + rs.length, 0);
				const views = [...pendingViews.values()].reduce((n, vs) => n + vs.size, 0);
				if (pending.size > MAX_PENDING_SCOPES || size > MAX_PENDING_RUNS || views > MAX_PENDING_RUNS) throw new Error("Forge subagent receipt bridge state exceeded safe limits");
			}
			if (root) for (const run of runs) credited.set(run.runId, run);
			const { forgeNestedUsage: _previous, ...rest } = d;
			// v1 cannot represent unknown input/output. Keep the complete model
			// envelope (including requests-only receipts), never invent token zeros.
			return { details: { ...rest, [KEY]: { schemaVersion: 1, runs } satisfies ForgeSubagentUsageEnvelope, ...(nested ? { forgeNestedUsage: nested } : {}) } };
		} catch (error) {
			pending.clear(); pendingViews.clear(); credited.clear(); poisoned = true;
			// Hook exceptions are swallowed by Pi; persist an explicit fail-closed marker
			// and remove unproven standard totals, which Forge would otherwise display.
			const { forgeNestedUsage: _unproven, ...rest } = d;
			return { details: { ...rest, forgeSubagentUsageError: { schemaVersion: 1, code: "receipt-accounting-incomplete", message: error instanceof Error ? error.message : "Invalid receipt accounting" } } };
		}
	});
	return () => { disposed = true; clear(); inFlight.clear(); inFlightCount = 0; for (const unsubscribe of off) unsubscribe(); };
}
