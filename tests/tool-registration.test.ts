import assert from "node:assert/strict";
import test from "node:test";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";
import type { ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";

test("forge_subagent tool is formally registered and fails cleanly without a host session", async () => {
	let captured: any;
	const pi = {
		registerTool: (tool: any) => { captured = tool; },
		on: (_name: string, _handler: any) => undefined,
		events: { emit: () => undefined, on: () => () => undefined },
	} as any;
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
		descriptors: () => [],
		prepare: async () => ({ ok: false as const, diagnostics: [] }),
		discard: async () => undefined,
		execute: async () => { throw new Error("should not execute"); },
		dispose: async () => undefined,
	};

	registerForgeSubagentTool(pi, runtime, { sessionProvider: () => undefined });
	assert.ok(captured);
	assert.equal(captured.name, "forge_subagent");

	const ctx = { hasUI: true, isProjectTrusted: () => true, cwd: "/tmp", sessionManager: { getSessionId: () => "s" }, modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false }, ui: { select: async () => "Reject", editor: async () => undefined, notify: () => undefined } } as any;
	const result = await captured.execute("call-1", { profileId: "project:worker", task: "Do x" }, undefined, undefined, ctx);
	const text = Array.isArray(result.content) ? result.content[0]?.text ?? "" : "";
	assert.match(text, /no Forge host session/);
});
