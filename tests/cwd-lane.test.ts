import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { findBubblewrapExecutable } from "@zihanw/pi-subagent-runtime/backends/bubblewrap";
import type { ForgePrepareRequest, ForgePrepareResponse } from "@zihanw/pi-forge/subagent";
import {
	negotiateSubagentTools,
	subagentPromptStackFingerprint,
	subagentSourceProfileFingerprint,
	type AgentProfileSnapshot,
	type SubagentDiagnostic,
} from "../src/contract/index.ts";
import { DeterministicFakeBackend } from "@zihanw/pi-subagent-runtime/testing";
import {
	createForgeSubagentRuntime,
	type ForgeSubagentRuntime,
} from "../src/runtime/subagent-runtime.ts";
import {
	isAllowedWorkingDirectory,
	loadForgeSubagentSettings,
} from "../src/config/subagents.ts";
import type { ForgeHostSession } from "../src/host/session.ts";

const TEST_GLOBAL_ROOT = join(tmpdir(), `pi-forge-subagents-cwd-test-global-${process.pid}`);
process.env.PI_FORGE_GLOBAL_FORGE_DIR = TEST_GLOBAL_ROOT;

const BWRAP_PATH = findBubblewrapExecutable(undefined);
const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;

async function createFixturePiRuntime(): Promise<{
	modelRuntime: ModelRuntime;
	modelRegistry: ModelRegistry;
}> {
	const faux = createFauxCore({
		api: "bwrap-fixture-api",
		provider: "test-provider",
		models: [{ id: "model-x", name: "Fixture", reasoning: true }],
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider("test-provider", {
		api: "bwrap-fixture-api",
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-key",
		streamSimple: (model: any, context: any, options?: any) =>
			faux.streamSimple(model, context, options),
		models: [{
			id: "model-x",
			name: "Fixture model",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_000,
			maxTokens: 4_000,
		}],
	});
	const modelRegistry = new ModelRegistry(modelRuntime);
	return { modelRuntime, modelRegistry };
}

const SNAPSHOT: AgentProfileSnapshot = {
	schemaVersion: 1,
	profileId: "project:worker",
	profile: {
		schemaVersion: 1,
		type: "pi-forge.agent-profile",
		id: "worker",
		model: { provider: "test-provider", id: "model-x" },
		thinkingLevel: "high",
		promptStack: "worker",
	},
	promptStackId: "project:worker",
	promptStack: { schemaVersion: 1, id: "worker", items: [] },
	dependencies: [],
	profileFingerprint: `sha256:v1:${"0".repeat(64)}`,
	promptStackFingerprint: `sha256:v1:${"0".repeat(64)}`,
};

SNAPSHOT.profileFingerprint = subagentSourceProfileFingerprint(SNAPSHOT.profile);
SNAPSHOT.promptStackFingerprint = subagentPromptStackFingerprint(SNAPSHOT.promptStack!);

function makeFakeSession(capturedHostRequests?: ForgePrepareRequest[]): ForgeHostSession {
	return {
		resolveProfile: async () => ({ snapshot: SNAPSHOT }),
		prepare: async (request: ForgePrepareRequest) => {
			if (capturedHostRequests) capturedHostRequests.push(request);
			const negotiation = negotiateSubagentTools(
				request.backend.toolCatalog as never,
				undefined,
				{ level: request.access.level, network: request.access.network, allowProcess: request.access.allowProcess } as never,
			);
			const response: ForgePrepareResponse = {
				profileId: "project:worker",
				model: request.backend.model,
				thinkingLevel: "high",
				systemPrompt: "You are a focused worker.",
				messages: [{ role: "user", content: [{ type: "text", text: request.task.text }], protectedTask: true, source: "delegated-task" }],
				effectiveToolIds: negotiation.effectiveToolIds,
				effectiveToolNames: negotiation.effectiveToolNames,
				diagnostics: negotiation.diagnostics,
				profileSnapshot: SNAPSHOT,
				preparedAt: "2026-07-14T00:00:00.000Z",
			};
			return response;
		},
	} as unknown as ForgeHostSession;
}

function makeContext(cwd: string, trusted = true, sessionId = "test-session"): ExtensionContext {
	return {
		cwd,
		isProjectTrusted: () => trusted,
		sessionManager: { getSessionId: () => sessionId },
		signal: undefined,
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			find: () => undefined,
			hasConfiguredAuth: () => false,
		} as any,
	} as unknown as ExtensionContext;
}

function initGitRepo(dir: string): void {
	spawnSync("git", ["init", "-b", "main"], { cwd: dir });
	spawnSync("git", ["config", "user.name", "CWD Test"], { cwd: dir });
	spawnSync("git", ["config", "user.email", "cwd-test@invalid"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "# Target Repo\n", "utf8");
	spawnSync("git", ["add", "README.md"], { cwd: dir });
	spawnSync("git", ["commit", "-m", "init"], { cwd: dir });
}

test("config: allowedWorkingDirectories parses canonical paths, resolves relative, and rejects invalid entries", () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-test-parent-"));
	const targetValid = mkdtempSync(join(tmpdir(), "cwd-test-target-"));
	const targetRelative = mkdtempSync(join(parentDir, "rel-target-"));
	const filePath = join(parentDir, "some-file.txt");
	writeFileSync(filePath, "not a directory", "utf8");

	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(parentDir, ".pi", "forge", "subagents.json"),
			JSON.stringify({
				allowedWorkingDirectories: [
					targetValid,
					`./${targetRelative.slice(parentDir.length + 1)}`,
					filePath, // invalid: file
					"/non/existent/path/xyz", // invalid: does not exist
					"", // invalid: empty string
				],
			}),
			"utf8",
		);

		const settings = loadForgeSubagentSettings(makeContext(parentDir));
		const canonicalValid = realpathSync(targetValid);
		const canonicalRelative = realpathSync(targetRelative);

		assert.ok(settings.allowedWorkingDirectories);
		assert.equal(settings.allowedWorkingDirectories.includes(canonicalValid), true);
		assert.equal(settings.allowedWorkingDirectories.includes(canonicalRelative), true);
		assert.equal(settings.allowedWorkingDirectories.length, 2);

		// Warnings emitted for invalid entries
		assert.ok(settings.warnings.some((w) => w.includes("not a directory")));
		assert.ok(settings.warnings.some((w) => w.includes("not an existing directory")));
		assert.ok(settings.warnings.some((w) => w.includes("non-empty strings")));

		// isAllowedWorkingDirectory helper
		assert.equal(isAllowedWorkingDirectory(settings, canonicalValid, parentDir), true);
		assert.equal(isAllowedWorkingDirectory(settings, parentDir, parentDir), true); // parent cwd implicitly allowed
		assert.equal(isAllowedWorkingDirectory(settings, "/some/random/dir", parentDir), false);
	} finally {
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(targetValid, { recursive: true, force: true });
	}
});

test("config: untrusted project ignores allowedWorkingDirectories", () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-test-untrusted-"));
	const targetDir = mkdtempSync(join(tmpdir(), "cwd-test-target-"));
	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(
			join(parentDir, ".pi", "forge", "subagents.json"),
			JSON.stringify({ allowedWorkingDirectories: [targetDir] }),
			"utf8",
		);

		const settings = loadForgeSubagentSettings(makeContext(parentDir, false));
		assert.equal(settings.allowedWorkingDirectories, undefined);
		assert.equal(isAllowedWorkingDirectory(settings, targetDir, parentDir), false);
		assert.equal(isAllowedWorkingDirectory(settings, parentDir, parentDir), true); // parent cwd still implicitly allowed
	} finally {
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
	}
});

test("runtime.prepare: rejects missing target cwd with host.cwd-missing", async () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-prepare-missing-"));
	const fakeBackend = new DeterministicFakeBackend({ id: "fake-backend", fidelity: "backend-assisted" });
	const runtime = createForgeSubagentRuntime(() => makeFakeSession(), {
		builtInBackends: false,
		extraBackends: [fakeBackend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});

	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		const result = await runtime.prepare("project:worker", "test", makeContext(parentDir), {
			backendId: "fake-backend",
			cwd: join(parentDir, "non-existent-subfolder"),
		});

		assert.equal(result.ok, false);
		assert.ok(result.diagnostics.some((d) => d.code === "host.cwd-missing"));
	} finally {
		await runtime.dispose();
		rmSync(parentDir, { recursive: true, force: true });
	}
});

test("runtime.prepare: rejects invalid target cwd (file, empty) with host.cwd-invalid", async () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-prepare-invalid-"));
	const filePath = join(parentDir, "file.txt");
	writeFileSync(filePath, "hello", "utf8");

	const fakeBackend = new DeterministicFakeBackend({ id: "fake-backend", fidelity: "backend-assisted" });
	const runtime = createForgeSubagentRuntime(() => makeFakeSession(), {
		builtInBackends: false,
		extraBackends: [fakeBackend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});

	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		// Target is a file, not a directory
		const resFile = await runtime.prepare("project:worker", "test", makeContext(parentDir), {
			backendId: "fake-backend",
			cwd: filePath,
		});
		assert.equal(resFile.ok, false);
		assert.ok(resFile.diagnostics.some((d) => d.code === "host.cwd-invalid"));

		// Target is empty string
		const resEmpty = await runtime.prepare("project:worker", "test", makeContext(parentDir), {
			backendId: "fake-backend",
			cwd: "   ",
		});
		assert.equal(resEmpty.ok, false);
		assert.ok(resEmpty.diagnostics.some((d) => d.code === "host.cwd-invalid"));
	} finally {
		await runtime.dispose();
		rmSync(parentDir, { recursive: true, force: true });
	}
});

test("runtime.prepare: unattended mode forbids non-parent target not on allowlist", async () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-unattended-parent-"));
	const targetDir = mkdtempSync(join(tmpdir(), "cwd-unattended-target-"));
	const allowedTargetDir = mkdtempSync(join(tmpdir(), "cwd-unattended-allowed-"));

	const fakeBackend = new DeterministicFakeBackend({ id: "fake-backend", fidelity: "backend-assisted" });
	const runtime = createForgeSubagentRuntime(() => makeFakeSession(), {
		builtInBackends: false,
		extraBackends: [fakeBackend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});

	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: true,
			allowedWorkingDirectories: [allowedTargetDir],
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		// Non-parent target not in allowedWorkingDirectories -> rejected
		const resForbidden = await runtime.prepare("project:worker", "test", makeContext(parentDir), {
			backendId: "fake-backend",
			cwd: targetDir,
		});
		assert.equal(resForbidden.ok, false);
		assert.ok(resForbidden.diagnostics.some((d) => d.code === "host.cwd-forbidden"));

		// Target IN allowedWorkingDirectories -> accepted
		const resAllowed = await runtime.prepare("project:worker", "test", makeContext(parentDir), {
			backendId: "fake-backend",
			cwd: allowedTargetDir,
		});
		assert.equal(resAllowed.ok, true);

		// Target is parent cwd -> implicitly allowed in unattended mode
		const resParent = await runtime.prepare("project:worker", "test", makeContext(parentDir), {
			backendId: "fake-backend",
			cwd: parentDir,
		});
		assert.equal(resParent.ok, true);
	} finally {
		await runtime.dispose();
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
		rmSync(allowedTargetDir, { recursive: true, force: true });
	}
});

test("runtime.prepare: interactive mode permits non-allowlisted target for later approval", async () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-interactive-parent-"));
	const targetDir = mkdtempSync(join(tmpdir(), "cwd-interactive-target-"));

	const fakeBackend = new DeterministicFakeBackend({ id: "fake-backend", fidelity: "backend-assisted" });
	const runtime = createForgeSubagentRuntime(() => makeFakeSession(), {
		builtInBackends: false,
		extraBackends: [fakeBackend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});

	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			allowAgentInvocationWithoutApproval: false, // interactive
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		// Interactive mode allows target directory preparation (human approval happens at tool layer)
		const res = await runtime.prepare("project:worker", "test", makeContext(parentDir), {
			backendId: "fake-backend",
			cwd: targetDir,
		});
		assert.equal(res.ok, true);
		assert.equal(res.prepared.cwd, realpathSync(targetDir));
		assert.equal((res.prepared.plan as any).targetPath, undefined, "cwd display does not invent a new plan schema field");
	} finally {
		await runtime.dispose();
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
	}
});

test("runtime: target dir does not spoof parent context or load target subagent config", async () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-spoof-parent-"));
	const targetDir = mkdtempSync(join(tmpdir(), "cwd-spoof-target-"));

	// Target has its own subagents.json disabling the profile
	mkdirSync(join(targetDir, ".pi", "forge"), { recursive: true });
	writeFileSync(join(targetDir, ".pi", "forge", "subagents.json"), JSON.stringify({
		profiles: { "project:worker": { enabled: false } },
	}), "utf8");

	// Parent has worker enabled
	mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
	writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
		profiles: { "project:worker": { enabled: true } },
	}), "utf8");

	const capturedHostRequests: ForgePrepareRequest[] = [];
	const fakeBackend = new DeterministicFakeBackend({ id: "fake-backend", fidelity: "backend-assisted" });
	const runtime = createForgeSubagentRuntime(() => makeFakeSession(capturedHostRequests), {
		builtInBackends: false,
		extraBackends: [fakeBackend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});

	try {
		const ctx = makeContext(parentDir);
		const preparation = await runtime.prepare("project:worker", "test task", ctx, {
			backendId: "fake-backend",
			cwd: targetDir,
		});

		// Policy stays parent context: enabled in parent subagents.json
		assert.equal(preparation.ok, true, preparation.ok ? undefined : preparation.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "));

		// Host prepare request protocol is strictly preserved: no new cwd field sent
		assert.equal(capturedHostRequests.length, 1);
		const hostReq = capturedHostRequests[0]!;
		assert.equal((hostReq as any).cwd, undefined);
		assert.equal((hostReq as any).targetCwd, undefined);
	} finally {
		await runtime.dispose();
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(targetDir, { recursive: true, force: true });
	}
});

test("runtime generations: different target runs do NOT dispose each other's generation in same session", async () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-gen-parent-"));
	const targetA = mkdtempSync(join(tmpdir(), "cwd-gen-targetA-"));
	const targetB = mkdtempSync(join(tmpdir(), "cwd-gen-targetB-"));

	let disposeCallCount = 0;
	const innerA = new DeterministicFakeBackend({ id: "fake-backend", fidelity: "backend-assisted" });
	const backend = {
		descriptor: innerA.descriptor,
		preflight: (input: any) => innerA.preflight(input),
		prepare: (input: any, context: any) => innerA.prepare(input, context),
		start: (input: any, context: any) => innerA.start(input, context),
		discard: (preparation: any) => innerA.discard(preparation),
		dispose: () => { disposeCallCount++; return Promise.resolve(); },
	} as any;

	const runtime = createForgeSubagentRuntime(() => makeFakeSession(), {
		builtInBackends: false,
		extraBackends: [backend],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});

	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		const ctx = makeContext(parentDir);

		// Prepare run for target A
		const prepA = await runtime.prepare("project:worker", "task A", ctx, {
			backendId: "fake-backend",
			cwd: targetA,
		});
		assert.equal(prepA.ok, true, prepA.ok ? undefined : prepA.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "));

		// Prepare run for target B in the same session
		const prepB = await runtime.prepare("project:worker", "task B", ctx, {
			backendId: "fake-backend",
			cwd: targetB,
		});
		assert.equal(prepB.ok, true);

		// Neither generation was disposed
		assert.equal(disposeCallCount, 0);

		// Both prepared runs can execute successfully against their respective generations
		innerA.executionMode = "completed";
		const respA = await runtime.execute(prepA.prepared, ctx);
		assert.equal(respA.status, "completed");

		const respB = await runtime.execute(prepB.prepared, ctx);
		assert.equal(respB.status, "completed");
	} finally {
		await runtime.dispose();
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(targetA, { recursive: true, force: true });
		rmSync(targetB, { recursive: true, force: true });
	}
});

test("runtime.execute: detects symlink drift and rejects execution", async () => {
	const parentDir = mkdtempSync(join(tmpdir(), "cwd-drift-parent-"));
	const realDirA = mkdtempSync(join(tmpdir(), "cwd-drift-realA-"));
	const realDirB = mkdtempSync(join(tmpdir(), "cwd-drift-realB-"));
	const symlinkDir = join(parentDir, "active-target");

	// Point symlink to realDirA
	symlinkSync(realDirA, symlinkDir, "dir");

	const fakeBackend = new DeterministicFakeBackend({ id: "fake-backend", fidelity: "backend-assisted" });
	const runtime = createForgeSubagentRuntime(() => makeFakeSession(), {
		builtInBackends: false,
		extraBackends: [fakeBackend as any],
		intentToolCatalog: [{ id: "tool.read", name: "read", effects: ["filesystem-read"] }],
	});

	try {
		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true } },
		}), "utf8");

		const ctx = makeContext(parentDir);
		const prep = await runtime.prepare("project:worker", "task", ctx, {
			backendId: "fake-backend",
			cwd: symlinkDir,
		});
		assert.equal(prep.ok, true, prep.ok ? undefined : prep.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "));

		// Now redirect the symlink to realDirB
		rmSync(symlinkDir);
		symlinkSync(realDirB, symlinkDir, "dir");

		// Execute should detect symlink drift and throw
		await assert.rejects(
			() => runtime.execute(prep.prepared, ctx),
			/symlink drift detected/,
		);
	} finally {
		await runtime.dispose();
		rmSync(parentDir, { recursive: true, force: true });
		rmSync(realDirA, { recursive: true, force: true });
		rmSync(realDirB, { recursive: true, force: true });
	}
});

test(
	"bubblewrap: target cwd git isolation checks are preserved",
	{ skip: process.platform !== "linux" || !BWRAP_PATH || !GIT_AVAILABLE },
	async () => {
		const parentDir = mkdtempSync(join(tmpdir(), "cwd-bwrap-parent-"));
		const nonGitTarget = mkdtempSync(join(tmpdir(), "cwd-bwrap-nongit-"));
		const gitTarget = mkdtempSync(join(tmpdir(), "cwd-bwrap-git-"));
		initGitRepo(gitTarget);

		const { modelRegistry } = await createFixturePiRuntime();

		mkdirSync(join(parentDir, ".pi", "forge"), { recursive: true });
		writeFileSync(join(parentDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true, backend: "pi-bwrap-write" } },
		}), "utf8");

		const runtime = createForgeSubagentRuntime(() => makeFakeSession(), {
			bubblewrap: {
				bwrapPath: BWRAP_PATH!,
			},
		});

		try {
			const ctx = {
				cwd: parentDir,
				isProjectTrusted: () => true,
				sessionManager: { getSessionId: () => "bwrap-session" },
				signal: undefined,
				modelRegistry: Object.create(modelRegistry, {
					getRegisteredProviderIds: { value: () => [] },
					getRegisteredNativeProvider: { value: () => undefined },
					getRegisteredProviderConfig: { value: () => undefined },
				}),
			} as unknown as ExtensionContext;

			// Non-git target should fail git requirement during Bubblewrap preflight
			const prepNonGit = await runtime.prepare("project:worker", "task", ctx, {
				backendId: "pi-bwrap-write",
				cwd: nonGitTarget,
			});
			assert.equal(prepNonGit.ok, false);
			assert.ok(prepNonGit.diagnostics.some((d) => d.code.includes("git-required")));

			// Git target preserves git workspace isolation check (passes git work tree check)
			const prepGit = await runtime.prepare("project:worker", "task", ctx, {
				backendId: "pi-bwrap-write",
				cwd: gitTarget,
			});
			// It should pass git check (no git-required error)
			const diagnostics = prepGit.ok ? prepGit.prepared.diagnostics : prepGit.diagnostics;
			const gitDiag = diagnostics.find((d) => d.code.includes("git-required"));
			assert.equal(gitDiag, undefined);
		} finally {
			await runtime.dispose();
			rmSync(parentDir, { recursive: true, force: true });
			rmSync(nonGitTarget, { recursive: true, force: true });
			rmSync(gitTarget, { recursive: true, force: true });
		}
	},
);
