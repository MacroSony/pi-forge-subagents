import assert from "node:assert/strict";
import test from "node:test";
import type { ForgeHostTransport } from "@zihanw/pi-forge/subagent";
import { ForgeHostSession } from "../src/host/session.ts";

class ResolveHostTransport implements ForgeHostTransport {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	private generation = 1;
	emit(channel: string, data: unknown): void {
		for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
	}
	on(channel: string, handler: (data: unknown) => void): () => void {
		const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
		set.add(handler);
		this.handlers.set(channel, set);
		let off = false;
		return () => { if (!off) { off = true; set.delete(handler); } };
	}
	start(): void {
		this.on("@zihanw/pi-forge/host/v1/discover", (data) => {
			if ((data as { type?: string }).type !== "discover") return;
			this.emit("@zihanw/pi-forge/host/v1/available", { type: "available", hostId: "resolve-host", protocolVersion: 1, minVersion: 1, maxVersion: 1, capabilities: ["listProfiles", "resolveProfile", "prepare"], generation: this.generation });
		});
		this.on("@zihanw/pi-forge/host/v1/request", (data) => {
			const message = data as { type?: string; requestId?: string; operation?: string };
			if (message?.type !== "request") return;
			this.emit("@zihanw/pi-forge/host/v1/reply", {
				type: "reply",
				requestId: message.requestId,
				hostId: "resolve-host",
				generation: this.generation,
				ok: true,
				data: {
					snapshot: { schemaVersion: 1, profileId: "project:worker", profile: { id: "worker" }, promptStackId: "project:worker", promptStack: { items: [] }, dependencies: [] },
				},
			});
		});
	}
}

test("ForgeHostSession resolves a profile snapshot through the host port", async () => {
	const transport = new ResolveHostTransport();
	transport.start();
	const session = await ForgeHostSession.connect(transport, { defaultTimeoutMs: 300, discoverSettleMs: 2 });
	const resolved = await session.resolveProfile("project:worker");
	assert.equal((resolved.snapshot as { profileId: string }).profileId, "project:worker");
	session.dispose();
});
