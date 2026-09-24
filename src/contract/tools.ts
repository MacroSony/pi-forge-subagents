import { applyResourcePolicy, resourcePatternMatches } from "./policy.ts";
import type { PromptToolPolicy } from "./types.ts";
import type { SubagentAccessRequest, SubagentBackendTool, SubagentDiagnostic, SubagentToolNegotiationResult } from "./types.ts";
import { validateToolCatalog } from "./validation.ts";

export function negotiateSubagentTools(
	catalog: readonly SubagentBackendTool[],
	policy: PromptToolPolicy | undefined,
	access: SubagentAccessRequest,
): SubagentToolNegotiationResult {
	const diagnostics: SubagentDiagnostic[] = [];
	validateToolCatalog(catalog, diagnostics);
	const names = catalog.map((tool) => tool.name);
	const initial = policy?.initial;
	if (Array.isArray(initial)) {
		for (const name of initial) {
			if (!names.includes(name)) {
				diagnostics.push({ level: "warning", code: "tools.initial-missing", path: `tools.initial.${name}`, message: `Preset initial tool ${name} is not registered by this backend.` });
			}
			if (applyResourcePolicy([name], policy).length === 0) {
				diagnostics.push({ level: "error", code: "tools.initial-blocked", path: `tools.initial.${name}`, message: `Preset initial tool ${name} is blocked by the allow/deny policy.` });
			}
		}
	}
	const sourceNames = Array.isArray(initial) ? names.filter((name) => initial.includes(name)) : names;
	const stackSelectedToolNames = applyResourcePolicy(sourceNames, policy);
	const selected = new Set(stackSelectedToolNames);
	const effective = catalog.filter((tool) => selected.has(tool.name) && toolAllowedByAccess(tool, access));
	const unmatchedAllowPatterns = policy && "allow" in policy
		? (policy.allow ?? []).filter((pattern) => pattern !== "*" && !names.some((name) => resourcePatternMatches(name, pattern)))
		: [];
	for (const pattern of unmatchedAllowPatterns) {
		diagnostics.push({ level: "warning", code: "tools.unmatched-allow", path: "tools.allow", message: `Tool allow pattern matches no backend tools: ${pattern}` });
	}
	for (const tool of catalog) {
		if (selected.has(tool.name) && !effective.includes(tool)) {
			diagnostics.push({ level: "info", code: "tools.access-filtered", path: `tools.${tool.name}`, message: `Tool ${tool.name} was removed by request access policy.` });
		}
	}
	return {
		effectiveToolIds: effective.map((tool) => tool.id),
		effectiveToolNames: effective.map((tool) => tool.name),
		stackSelectedToolNames,
		unmatchedAllowPatterns,
		diagnostics,
	};
}

function toolAllowedByAccess(tool: SubagentBackendTool, access: SubagentAccessRequest): boolean {
	for (const effect of tool.effects) {
		if (effect === "network" && access.network !== "allow") return false;
		if (effect === "process" && access.allowProcess !== true) return false;
		if (effect === "filesystem-read" && access.level === "none") return false;
		if (effect === "filesystem-write" && access.level !== "workspace-write") return false;
	}
	return true;
}
