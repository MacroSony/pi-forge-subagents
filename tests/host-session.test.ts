import assert from "node:assert/strict";
import test from "node:test";
import type { ForgeHostTransport } from "@zihanw/pi-forge/subagent";
import { ForgeHostSession } from "../src/host/session.ts";

// Documented `/subagent` host-port channels (protocol conformance literals).
const CH = {
	discover: "@zihanw/pi-forge/host/v1/discover",
	available: "@zihanw/pi-forge/host/v1/available",
	request: "@zihanw/pi-forge/host/v1/request",
	reply: "@zihanw/pi-forge/host/v1/reply",
	unavailable: "@zihanw/pi-forge/host/v1/unavailable",
};

const HOST_ID = "test-host";
const RESPONSE = {
	profileId: "project:worker",
	model: { provider: "test-provider", id: "model-x" },
	thinkingLevel: "high",
	systemPrompt: "You are a focused reviewer.",
	messages: [{ role: "user", content: [{ type: "text", text: "task" }], source: "prompt-stack" }],
	effectiveToolIds: [],
	effectiveToolNames: [],
	diagnostics: [],
	profileSnapshot: { schemaVersion: 1, profileId: "project:worker", profile: { id: "worker" }, promptStackId: "project:worker", promptStack: { items: [] }, dependencies: [] },
	preparedAt: "2026-07-14T00:00:00.000Z",
};

class FakeHostTransport implements ForgeHostTransport {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
	private generation = 1;
	private unsubscribers: (() => void)[] = [];

	listeners(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}

	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}

	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
		set.add(handler);
		this.handlers.set(channel, set);
		let removed = false;
		return () => {
			if (removed) return;
			removed = true;
			set.delete(handler);
		};
	}

	start(): void {
		this.unsubscribers.push(this.on(CH.discover, (data) => {
			const message = data as { type: string };
			if (message?.type !== "discover") return;
			this.emit(CH.available, {
				type: "available",
				hostId: HOST_ID,
				protocolVersion: 1,
				minVersion: 1,
				maxVersion: 1,
				capabilities: ["listProfiles", "prepare"],
				generation: this.generation,
			});
		}));
		this.unsubscribers.push(this.on(CH.request, (data) => {
			const message = data as { type: string; requestId?: string; operation?: string; payload?: unknown };
			if (message?.type !== "request") return;
			const base = { type: "reply", requestId: message.requestId, hostId: HOST_ID, generation: this.generation };
			if (message.operation === "listProfiles") {
				this.emit(CH.reply, { ...base, ok: true, data: { profiles: [{ profileId: "worker", scope: "project", model: { provider: "test-provider", id: "model-x" }, thinkingLevel: "high", promptStack: "worker", usable: true, diagnostics: [] }] } });
				return;
			}
			if (message.operation === "prepare") {
				this.emit(CH.reply, { ...base, ok: true, data: RESPONSE });
				return;
			}
			this.emit(CH.reply, { ...base, ok: false, error: `unknown operation: ${message.operation}` });
		}));
	}

	dispose(): void {
		this.emit(CH.unavailable, { type: "unavailable", hostId: HOST_ID, generation: this.generation });
		this.generation += 1;
		for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
	}
}

test("optional package consumes the host port: discover -> list -> prepare -> disposal", async () => {
	const transport = new FakeHostTransport();
	transport.start();
	const session = await ForgeHostSession.connect(transport, { defaultTimeoutMs: 300, discoverSettleMs: 2 });
	assert.equal(session.hostId, HOST_ID);
	assert.equal(session.generation, 1);

	const profiles = await session.listProfiles();
	assert.deepEqual(profiles.map((profile) => profile.profileId), ["worker"]);

	const prepared = await session.prepare({
		profile: "project:worker",
		task: { text: "Review this task." },
		access: { level: "read-only", network: "deny", allowProcess: false },
		backend: { model: { provider: "test-provider", id: "model-x" }, thinkingLevel: "high", toolCatalog: [] },
	});
	assert.equal(prepared.systemPrompt, "You are a focused reviewer.");
	assert.equal(prepared.profileId, "project:worker");
	assert.ok(prepared.profileSnapshot);

	let unavailable = 0;
	session.onUnavailable(() => { unavailable += 1; });
	transport.dispose();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(unavailable, 1, "consumer must observe host disposal");
	await assert.rejects(session.prepare({
		profile: "project:worker",
		task: { text: "x" },
		access: { level: "read-only", network: "deny", allowProcess: false },
		backend: { model: { provider: "test-provider", id: "model-x" }, thinkingLevel: "high", toolCatalog: [] },
	}), /not connected/);
	session.dispose();
});
