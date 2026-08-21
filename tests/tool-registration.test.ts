import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseForgeSubagentModel, registerForgeSubagentTool, renderApprovalSummary } from "../src/tool/forge-subagent.ts";
import type { ForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";
import type { ForgeSubagentToolDetails } from "../src/tool/forge-subagent.ts";

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

test("forge_subagent explains how a bare global config key differs from a global selector", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-tool-global-hint-project-"));
	const globalRoot = mkdtempSync(join(tmpdir(), "pi-forge-subagents-tool-global-hint-config-"));
	const previousForge = process.env.PI_FORGE_GLOBAL_FORGE_DIR;
	try {
		process.env.PI_FORGE_GLOBAL_FORGE_DIR = globalRoot;
		mkdirSync(join(globalRoot, ".pi", "forge"), { recursive: true });
		writeFileSync(join(globalRoot, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { reviewer: { enabled: true } },
		}), "utf8");
		let captured: any;
		const pi = { registerTool: (tool: any) => { captured = tool; } } as any;
		const runtime = {
			backendIds: () => [],
			descriptors: () => [],
			prepare: async () => ({ ok: false as const, diagnostics: [] }),
			discard: async () => undefined,
			execute: async () => { throw new Error("should not execute"); },
			dispose: async () => undefined,
		} as ForgeSubagentRuntime;
		registerForgeSubagentTool(pi, runtime, { sessionProvider: () => ({}) as any });
		const ctx = {
			cwd,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "s" },
			modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false },
			ui: { select: async () => "Reject", editor: async () => undefined, notify: () => undefined },
		} as any;

		const result = await captured.execute("call", { profileId: "global:reviewer", task: "x" }, undefined, undefined, ctx);
		const text = Array.isArray(result.content) ? result.content[0]?.text ?? "" : "";
		assert.match(text, /key "reviewer" authorizes only project:reviewer/);
		assert.match(text, /use "global:reviewer"/);
	} finally {
		if (previousForge === undefined) delete process.env.PI_FORGE_GLOBAL_FORGE_DIR;
		else process.env.PI_FORGE_GLOBAL_FORGE_DIR = previousForge;
		rmSync(cwd, { recursive: true, force: true });
		rmSync(globalRoot, { recursive: true, force: true });
	}
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

test("parseForgeSubagentModel parses provider/id strings and rejects malformed values", () => {
	assert.deepEqual(parseForgeSubagentModel("openai/gpt-4o"), { ok: true, model: { provider: "openai", id: "gpt-4o" } });
	assert.deepEqual(parseForgeSubagentModel("  openai / gpt-4o  "), { ok: true, model: { provider: "openai", id: "gpt-4o" } });
	for (const value of ["", "no-slash", "/missing-provider", "provider/", " / "]) {
		const parsed = parseForgeSubagentModel(value);
		assert.equal(parsed.ok, false, value);
	}
});

test("renderApprovalSummary shows the effective model from the sealed plan", () => {
	const prepared = {
		plan: {
			profile: {
				profileId: "project:worker",
				promptStackId: "project:worker",
				profile: { model: { provider: "default-provider", id: "default-model" }, thinkingLevel: "high" },
			},
			model: { provider: "override-provider", id: "override-model" },
			backendId: "pi-subprocess-readonly",
			systemPrompt: "system",
			messages: [],
			effectiveToolIds: [],
			executionFingerprint: "execution",
			conversationFingerprint: "conversation",
		},
	} as any;
	const summary = renderApprovalSummary(prepared, "Inspect this code carefully.");
	assert.match(summary, /override-provider\/override-model/);
	assert.doesNotMatch(summary, /default-provider/);
});

test("forge_subagent rejects per-call model override in unattended mode", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-unattended-model-"));
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
			backendIds: () => [],
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
		const result = await captured.execute("call", { profileId: "project:worker", task: "x", model: "override-provider/override-model" }, undefined, undefined, ctx);
		const text = Array.isArray(result.content) ? result.content[0]?.text ?? "" : "";
		assert.match(text, /pinned to the profile\/configured model/);
		assert.equal(prepareCalled, false);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("forge_subagent applies per-call model override for interactively approved runs", async () => {
	const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-interactive-model-"));
	const prepareRuns: Array<{ model?: { provider: string; id: string } } | undefined> = [];
	try {
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		let captured: any;
		const pi = { registerTool: (tool: any) => { captured = tool; } } as any;
		const runtime: ForgeSubagentRuntime = {
			backendIds: () => [],
			descriptors: () => [],
			prepare: async (_profileId, _task, _ctx, run) => {
				prepareRuns.push(run);
				return { ok: false as const, diagnostics: [] };
			},
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
		const result = await captured.execute("call", { profileId: "project:worker", task: "x", model: "override-provider/override-model" }, undefined, undefined, ctx);
		assert.equal(result.details.status, "failed");
		assert.deepEqual(prepareRuns[0]?.model, { provider: "override-provider", id: "override-model" });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("forge_subagent renderers show live progress, approval receipt, and usage stats", () => {
	let captured: any;
	const pi = { registerTool: (tool: any) => { captured = tool; } } as any;
	const runtime: ForgeSubagentRuntime = {
		backendIds: () => [],
		descriptors: () => [],
		prepare: async () => ({ ok: false as const, diagnostics: [] }),
		discard: async () => undefined,
		execute: async () => { throw new Error("should not execute"); },
		dispose: async () => undefined,
	};
	registerForgeSubagentTool(pi, runtime, { sessionProvider: () => undefined });

	const theme = fakeTheme();
	const call = captured.renderCall({ profileId: "project:worker", task: "Inspect this code carefully." }, theme, {});
	assert.match(call.render(100).join("\n"), /forge subagent/);

	const details = {
		status: "running",
		profileId: "project:worker",
		task: "Inspect this code carefully.",
		approval: { required: true, approved: true, viewedFullPrompt: true, source: "human", executionFingerprint: "fp", approvedAt: "2026-07-14T00:00:00.000Z" },
		diagnostics: [],
		progress: [
			{ phase: "starting", message: "Starting reviewer." },
			{ phase: "tool-result", message: "read completed." },
		],
		response: {
			model: { provider: "override-provider", id: "override-model" },
			durationMs: 1234,
			usage: { tokens: { input: 10, output: 20, total: 30 }, cost: { amount: 0.0012, currency: "USD" } },
		} as any,
	} as ForgeSubagentToolDetails;
	const resultArg = { content: [{ type: "text", text: "Review complete with evidence." }], details };

	const collapsed = captured.renderResult(resultArg, { expanded: false, isPartial: true }, theme, {});
	const collapsedText = collapsed.render(100).join("\n");
	assert.match(collapsedText, /live/);
	assert.match(collapsedText, /approved after full-prompt review/);
	assert.match(collapsedText, /10 input/);

	const expanded = captured.renderResult(resultArg, { expanded: true, isPartial: false }, theme, {});
	const expandedText = expanded.render(120).join("\n");
	assert.match(expandedText, /Live progress/);
	assert.match(expandedText, /read completed/);
	assert.match(expandedText, /Approval: approved after full-prompt review/);
	assert.match(expandedText, /override-provider\/override-model/);
	assert.match(expandedText, /10 input · 20 output · 30 total/);
});

function fakeTheme(): any {
	return { fg: (_name: string, text: string) => text, bold: (text: string) => text } as any;
}

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
