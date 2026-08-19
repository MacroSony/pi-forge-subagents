import assert from "node:assert/strict";
import test from "node:test";
import { registerForgeAgentCommand } from "../src/command/forge-agent.ts";
import type { ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";

test("forge-agent command registers and backends renders registered backend info", async () => {
	let captured: any;
	const pi = {
		registerCommand: (_name: string, command: any) => { captured = command; },
	} as any;
	const runtime = {
		descriptors: () => [{
			id: "pi-subprocess-readonly",
			version: "v1",
			capabilities: { promptRuntimeFidelity: "backend-assisted", cancellation: true, remoteTransport: false },
		}],
		prepare: async () => ({ ok: false as const, diagnostics: [] }),
		discard: async () => undefined,
		execute: async () => { throw new Error("not executed"); },
	} as unknown as ForgeSubagentRuntime;

	registerForgeAgentCommand(pi, runtime, () => undefined);
	assert.ok(captured);
	assert.equal(typeof captured.handler, "function");

	const editors: { title: string; text: string }[] = [];
	const ctx = {
		cwd: "/tmp",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "s" },
		modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
		ui: {
			theme: { fg: (_c: string, text: string) => text },
			notify: () => undefined,
			setStatus: () => undefined,
			editor: async (title: string, text: string) => { editors.push({ title, text }); },
		},
		signal: undefined,
	} as any;

	await captured.handler("backends", ctx);
	assert.equal(editors.length, 1);
	assert.match(editors[0]!.text, /pi-subprocess-readonly/);
});
