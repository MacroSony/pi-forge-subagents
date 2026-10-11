import type { ForgeSubagentPreparedRun } from "../runtime/subagent-runtime.ts";
import { plainSubagentText } from "./plain-text.ts";

/** Optional historical metadata: never resolve today's profile defaults during rendering. */
export interface SubagentExecutionDisplay {
	model: { provider: string; id: string };
	thinkingLevel?: string;
	backendId: string;
	cwd?: string;
	runId: string;
	mode: "foreground" | "background";
	contextMode: "one-shot" | "retained" | "continued";
	startedAt?: number;
}

export function snapshotSubagentExecution(prepared: ForgeSubagentPreparedRun, mode: SubagentExecutionDisplay["mode"]): SubagentExecutionDisplay | undefined {
	const { plan } = prepared;
	// Legacy adapters/fixtures may lack a complete display snapshot; do not invent it.
	if (!plan.model || !plan.backendId || !plan.runId) return undefined;
	return {
		model: { provider: plan.model.provider, id: plan.model.id },
		...(plan.thinkingLevel !== undefined ? { thinkingLevel: plan.thinkingLevel } : {}),
		backendId: plan.backendId,
		...(prepared.cwd !== undefined ? { cwd: prepared.cwd } : {}),
		runId: plan.runId, mode,
		contextMode: prepared.continueId ? "continued" : prepared.keepContext ? "retained" : "one-shot",
	};
}

export function executionDisplayLines(execution?: SubagentExecutionDisplay, reportedModel?: { provider: string; id: string }): string[] {
	const selected = execution?.model;
	const mismatch = selected && reportedModel && (selected.provider !== reportedModel.provider || selected.id !== reportedModel.id);
	const lines: string[] = [];
	if (selected) lines.push(`${mismatch ? "selected " : ""}${plainSubagentText(selected.provider)}/${plainSubagentText(selected.id)}`);
	else if (reportedModel) lines.push(`reported ${plainSubagentText(reportedModel.provider)}/${plainSubagentText(reportedModel.id)}`);
	else lines.push("model unresolved");
	lines[0] += ` · thinking ${plainSubagentText(execution?.thinkingLevel ?? "unknown")}`;
	if (mismatch) lines.push(`reported ${plainSubagentText(reportedModel.provider)}/${plainSubagentText(reportedModel.id)}`);
	return lines;
}
