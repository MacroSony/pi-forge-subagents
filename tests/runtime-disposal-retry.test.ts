import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DeterministicFakeBackend } from "@zihanw/pi-subagent-runtime/testing";
import { createForgeSubagentRuntime } from "../src/runtime/subagent-runtime.ts";

class FlakyDisposeBackend extends DeterministicFakeBackend {
	disposeCalls = 0;
	readonly failures: number;
	constructor(failures: number) {
		super({ id: "flaky-dispose", fidelity: "backend-assisted" });
		this.failures = failures;
	}
	async dispose(): Promise<void> {
		this.disposeCalls += 1;
		if (this.disposeCalls <= this.failures) throw new Error(`injected dispose failure ${this.disposeCalls}`);
	}
}

function context(cwd: string): ExtensionContext {
	return {
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "disposal-retry-session" },
		signal: undefined,
		modelRegistry: { getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false } as any,
	} as unknown as ExtensionContext;
}

async function withCapturedErrors<T>(fn: () => Promise<T>): Promise<{ value: T; errors: string[] }> {
	const errors: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
	try {
		return { value: await fn(), errors };
	} finally {
		console.error = original;
	}
}

test("subagent runtime shutdown retries a failed backend cleanup until it succeeds", async () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-disposal-retry-"));
	const backend = new FlakyDisposeBackend(1);
	const runtime = createForgeSubagentRuntime(() => undefined as any, { builtInBackends: false, extraBackends: [backend as any] });
	try {
		assert.ok(runtime.descriptors(context(dir)).some((d) => d.id === "flaky-dispose"));
		const { errors } = await withCapturedErrors(() => runtime.dispose());
		assert.equal(backend.disposeCalls, 2);
		assert.deepEqual(errors, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("subagent runtime shutdown stops retrying after a bounded number of attempts and reports the failure", async () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-disposal-bounded-"));
	const backend = new FlakyDisposeBackend(Number.POSITIVE_INFINITY);
	const runtime = createForgeSubagentRuntime(() => undefined as any, { builtInBackends: false, extraBackends: [backend as any] });
	try {
		runtime.descriptors(context(dir));
		const { errors } = await withCapturedErrors(() => runtime.dispose());
		assert.equal(backend.disposeCalls, 3);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /runtime disposal failed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
