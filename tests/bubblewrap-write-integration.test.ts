import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createFauxCore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ForgePrepareRequest, ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import { findBubblewrapExecutable } from "@zihanw/pi-subagent-runtime/backends/bubblewrap";
import {
	negotiateSubagentTools,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	type AgentProfileSnapshot,
} from "../src/contract/index.ts";
import type { ForgeHostSession } from "../src/host/session.ts";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";

const BWRAP_PATH = findBubblewrapExecutable(undefined);
const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;
const PROVIDER = "pi-forge-subagents-bwrap-fixture";
const MODEL_ID = "fixture-model";
const API = "pi-forge-subagents-bwrap-api";

test(
	"Forge runtime projects the Bubblewrap write preset and edits the real git workspace",
	{ skip: process.platform !== "linux" || !BWRAP_PATH || !GIT_AVAILABLE },
	async () => {
		const cwd = createGitWorkspace();
		const { modelRuntime, modelRegistry } = await createFixturePiRuntime();
		const snapshot = fixtureSnapshot();
		let hostRequest: ForgePrepareRequest | undefined;
		const session = {
			resolveProfile: async () => ({ snapshot }),
			prepare: async (request: ForgePrepareRequest) => {
				hostRequest = request;
				const negotiation = negotiateSubagentTools(
					request.backend.toolCatalog as never,
					undefined,
					request.access as never,
				);
				return {
					profileId: snapshot.profileId,
					model: request.backend.model,
					thinkingLevel: "high",
					systemPrompt: "You are a fixture writer.",
					messages: [{ role: "user", content: [{ type: "text", text: "Write the fixture." }], protectedTask: true, source: "delegated-task" }],
					effectiveToolIds: negotiation.effectiveToolIds,
					effectiveToolNames: negotiation.effectiveToolNames,
					diagnostics: negotiation.diagnostics,
					profileSnapshot: snapshot,
					preparedAt: "2026-08-30T00:00:00.000Z",
				} satisfies ForgePrepareResponse;
			},
		} as unknown as ForgeHostSession;
		const ctx = {
			cwd,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "bwrap-integration-session" },
			signal: undefined,
			modelRegistry,
		} as any;
		mkdirSync(join(cwd, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "forge", "subagents.json"),
			JSON.stringify({
				profiles: {
					"project:worker": { enabled: true, backend: "pi-bwrap-write" },
				},
			}),
			"utf8",
		);
		const runtime = createForgeSubagentRuntime(() => session, {
			bubblewrap: {
				bwrapPath: BWRAP_PATH!,
				invocationFactory: () => fixtureInvocation(),
			},
		});

		try {
			const preparation = await runtime.prepare("project:worker", "Write the fixture.", ctx);
			assert.equal(
				preparation.ok,
				true,
				preparation.ok ? undefined : preparation.diagnostics.map((item) => item.message).join("; "),
			);
			assert.equal(hostRequest?.access.level, "workspace-write");
			assert.equal(hostRequest?.access.allowProcess, true);
			assert.equal(preparation.prepared.plan.access.executionBoundary, "isolated");
			assert.equal(preparation.prepared.plan.access.mounts[0]?.mode, "read-write");
			assert.ok(preparation.prepared.plan.effectiveToolIds.includes("pi.bash"));

			const response = await runtime.execute(preparation.prepared, ctx);
			assert.equal(response.status, "completed");
			assert.equal(
				readFileSync(join(cwd, "forge-bwrap-integration.txt"), "utf8"),
				"forge bwrap integration passed\n",
			);
		} finally {
			await runtime.dispose();
			modelRegistry.unregisterProvider(PROVIDER);
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);

async function createFixturePiRuntime(): Promise<{
	modelRuntime: ModelRuntime;
	modelRegistry: ModelRegistry;
}> {
	const faux = createFauxCore({
		api: API,
		provider: PROVIDER,
		models: [{ id: MODEL_ID, name: "Fixture", reasoning: true }],
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(PROVIDER, {
		api: API,
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-key",
		streamSimple: (model: Model<any>, context: Context, options?: SimpleStreamOptions) =>
			faux.streamSimple(model, context, options),
		models: [{
			id: MODEL_ID,
			name: "Fixture model",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 4_000,
		}],
	});
	return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

function fixtureSnapshot(): AgentProfileSnapshot {
	const profile = {
		schemaVersion: 1 as const,
		type: "pi-forge.agent-profile" as const,
		id: "worker",
		model: { provider: PROVIDER, id: MODEL_ID },
		thinkingLevel: "high" as const,
		promptStack: "worker",
	};
	const promptStack = { schemaVersion: 1 as const, id: "worker", items: [] };
	return {
		schemaVersion: 1,
		profileId: "project:worker",
		profile,
		promptStackId: "project:worker",
		promptStack,
		dependencies: [],
		profileFingerprint: subagentSourceProfileFingerprint(profile),
		promptStackFingerprint: subagentPromptStackFingerprint(promptStack),
	};
}

function fixtureInvocation() {
	return {
		command: process.execPath,
		args: [
			"--input-type=module",
			"-e",
			`
				const { writeFileSync, writeSync } = await import("node:fs");
				writeFileSync("forge-bwrap-integration.txt", "forge bwrap integration passed\\n", "utf8");
				writeSync(3, JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Fixture write completed." }],
						api: "fixture",
						provider: ${JSON.stringify(PROVIDER)},
						model: ${JSON.stringify(MODEL_ID)},
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
						stopReason: "stop",
						timestamp: 1,
					},
				}) + "\\n");
			`,
		],
	};
}

function createGitWorkspace(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-forge-subagents-bwrap-write-"));
	writeFileSync(join(cwd, "baseline.txt"), "baseline\n", "utf8");
	runGit(cwd, "init", "--quiet");
	runGit(cwd, "config", "user.email", "fixture@example.invalid");
	runGit(cwd, "config", "user.name", "Fixture");
	runGit(cwd, "add", "baseline.txt");
	runGit(cwd, "commit", "--quiet", "-m", "baseline");
	return cwd;
}

function runGit(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
}
