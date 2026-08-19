import type { ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import type { ForgeHostSession } from "../host/session.ts";

export interface SubagentToolInput {
	profile: string;
	task: string;
	access?: { level: "none" | "read-only" | "workspace-write"; network: "deny" | "allow"; allowProcess?: boolean };
	toolCatalog?: Array<{ id: string; name?: string; effects?: string[] }>;
}

export interface SubagentToolContext {
	session: ForgeHostSession | undefined;
	/** Backend model facts plus delegate. */
	backendModel?: { provider: string; id: string };
	thinkingLevel?: string;
}

/**
 * Host-port-backed forge_subagent invocation. The optional package sends only
 * the profile selector + task + prompt access facts + backend model/tool
 * catalog; the main pi-forge host owns profile/stack resolution and prompt
 * compilation and returns the immutable preparation artifact.
 */
export async function invokeSubagentTool(
	input: SubagentToolInput,
	context: SubagentToolContext,
): Promise<{ ok: true; prepared: ForgePrepareResponse } | { ok: false; error: string }> {
	if (!context.session) {
		return { ok: false, error: "pi-forge-subagents: no Forge host session (start a session first)." };
	}
	if (!context.backendModel) {
		return { ok: false, error: "pi-forge-subagents: no backend model facts configured." };
	}
	try {
		const prepared = await context.session.prepare({
			profile: input.profile,
			task: { text: input.task },
			access: {
				level: input.access?.level ?? "read-only",
				network: input.access?.network ?? "deny",
				allowProcess: input.access?.allowProcess ?? false,
			},
			backend: {
				model: context.backendModel,
				thinkingLevel: context.thinkingLevel ?? "high",
				toolCatalog: input.toolCatalog ?? [],
			},
		});
		return { ok: true, prepared };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
