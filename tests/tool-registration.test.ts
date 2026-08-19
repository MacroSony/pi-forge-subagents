import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerForgeSubagentTool } from "../src/tool/forge-subagent.ts";
import type { ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";

process.env.PI_FORGE_GLOBAL_FORGE_DIR = join(tmpdir(), `pi-forge-subagents-tool-global-${process.pid}`);

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

test("forge_subagent rejects per-call backend override in unattended mode", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-unattended-"));
	let prepareCalled = false;
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: true,
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		let captured: any;
		const pi = { registerTool: (tool: any) => { captured = tool; } } as any;
		const runtime: ForgeSubagentRuntime = {
			backendIds: () => ["pi-subprocess-readonly", "pi-rpc-readonly"],
			descriptors: () => [],
			prepare: async () => { prepareCalled = true; return { ok: false as const, diagnostics: [] }; },
			discard: async () => undefined,
			execute: async () => { throw new Error("should not execute"); },
			dispose: async () => undefined,
		};
		const session = { resolveProfile: async () => ({ snapshot: {} }), prepare: async () => { throw new Error("should not prepare"); } } as any;
		registerForgeSubagentTool(pi, runtime, { sessionProvider: () => session });
		const ctx = {
			cwd,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "s" },
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
			ui: { select: async () => "Reject", editor: async () => undefined, notify: () => undefined },
		} as any;
		const result = await captured.execute("call", { profileId: "project:worker", task: "x", backend: "pi-rpc-readonly" }, undefined, undefined, ctx);
		const text = Array.isArray(result.content) ? result.content[0]?.text ?? "" : "";
		assert.match(text, /pinned to the configured backend/);
		assert.equal(prepareCalled, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("forge_subagent rejects an unknown backend before approval", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-backend-"));
	let prepareCalled = false;
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({ profiles: { "project:worker": { enabled: true } } }), "utf8");
		let captured: any;
		const pi = { registerTool: (tool: any) => { captured = tool; } } as any;
		const runtime: ForgeSubagentRuntime = {
			backendIds: () => ["pi-subprocess-readonly"],
			descriptors: () => [],
			prepare: async () => { prepareCalled = true; return { ok: false as const, diagnostics: [] }; },
			discard: async () => undefined,
			execute: async () => { throw new Error("should not execute"); },
			dispose: async () => undefined,
		};
		const session = { resolveProfile: async () => ({ snapshot: {} }), prepare: async () => { throw new Error("should not prepare"); } } as any;
		registerForgeSubagentTool(pi, runtime, { sessionProvider: () => session });
		const ctx = {
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "s" },
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
			ui: { select: async () => "Reject", editor: async () => undefined, notify: () => undefined },
		} as any;
		const result = await captured.execute("call", { profileId: "project:worker", task: "x", backend: "missing" }, undefined, undefined, ctx);
		const text = Array.isArray(result.content) ? result.content[0]?.text ?? "" : "";
		assert.match(text, /Unknown backend/);
		assert.equal(prepareCalled, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
