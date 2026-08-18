import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ForgePrepareRequest } from "@zihanw/pi-forge/subagent";
import { ForgeHostSession } from "./host/session.ts";

export { ForgeHostSession } from "./host/session.ts";
export type { ForgeHostSessionOptions } from "./host/session.ts";

export interface ForgeSubagentsExtensionContext {
	session?: ForgeHostSession;
}

/**
 * Pi extension entry point for the optional subagent integration.
 *
 * It discovers the active pi-forge host through `pi.events` using the
 * versioned `/subagent` host port, then exposes profile listing and prompt
 * preparation as model-callable/command surface. All profile/stack/compile
 * ownership stays in the main pi-forge host; this package only consumes the
 * published port and owns execution/config.
 */
export default function piForgeSubagents(pi: ExtensionAPI): ForgeSubagentsExtensionContext {
	const context: ForgeSubagentsExtensionContext = {};

	pi.on("session_start", async (_event: unknown) => {
		context.session?.dispose();
		context.session = await ForgeHostSession.connect(pi.events as never);
	});

	pi.on("session_shutdown", async () => {
		context.session?.dispose();
		context.session = undefined;
	});

	pi.registerCommand("subagent", {
		description: "List Forge profiles and prepare delegated prompts through the active pi-forge host.",
		handler: async (args: string, ctx) => {
			const session = context.session;
			if (!session) {
				ctx.ui.notify("pi-forge-subagents: no Forge host session (start a session first).", "warning");
				return;
			}
			const trimmed = args.trim();
			const [command = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : ["list"];
			if (command === "list") {
				const profiles = await session.listProfiles();
				ctx.ui.notify(profiles.map((profile) => `${profile.scope}:${profile.profileId}`).join("\n") || "No profiles.", "info");
				return;
			}
			if (command === "plan" && rest[0]) {
				const request: ForgePrepareRequest = {
					profile: rest[0],
					task: { text: rest.slice(1).join(" ") || "Delegate this task." },
					access: { level: "read-only", network: "deny", allowProcess: false },
					backend: {
						model: { provider: "unknown", id: "unknown" },
						thinkingLevel: "high",
						toolCatalog: [],
					},
				};
				const prepared = await session.prepare(request);
				ctx.ui.notify(prepared.systemPrompt || "(empty system prompt)", "info");
				return;
			}
			ctx.ui.notify("Usage: /subagent list | plan <profile> [task]", "info");
		},
	});

	return context;
}
