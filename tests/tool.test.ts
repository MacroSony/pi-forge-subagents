import assert from "node:assert/strict";
import test from "node:test";
import { invokeSubagentTool } from "../src/tool/subagent-tool.ts";
import { ForgeHostSession } from "../src/host/session.ts";
import type { ForgeHostTransport } from "@zihanw/pi-forge/subagent";

class FakeHostTransport implements ForgeHostTransport {
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
	listeners(channel: string): number {
		return this.handlers.get(channel)?.size ?? 0;
	}
	start(): void {
		this.on("@zihanw/pi-forge/host/v1/discover", (data) => {
			if ((data as { type?: string }).type !== "discover") return;
			this.emit("@zihanw/pi-forge/host/v1/available", { type: "available", hostId: "tool-host", protocolVersion: 1, minVersion: 1, maxVersion: 1, capabilities: ["listProfiles", "prepare"], generation: this.generation });
		});
		this.on("@zihanw/pi-forge/host/v1/request", (data) => {
			const message = data as { type?: string; requestId?: string; operation?: string };
			if (message?.type !== "request") return;
			this.emit("@zihanw/pi-forge/host/v1/reply", {
				type: "reply",
				requestId: message.requestId,
				hostId: "tool-host",
				generation: this.generation,
				ok: true,
				data: {
					profileId: "project:worker",
					model: { provider: "test-provider", id: "model-x" },
					thinkingLevel: "high",
					systemPrompt: "You are a focused reviewer.",
					messages: [],
					effectiveToolIds: [],
					effectiveToolNames: [],
					diagnostics: [],
					profileSnapshot: { schemaVersion: 1, profileId: "project:worker" },
					preparedAt: "2026-07-14T00:00:00.000Z",
				},
			});
		});
	}
}

test("forge_subagent tool prepares through the host port", async () => {
	const transport = new FakeHostTransport();
	transport.start();
	const session = await ForgeHostSession.connect(transport, { defaultTimeoutMs: 300, discoverSettleMs: 2 });
	const result = await invokeSubagentTool(
		{ profile: "project:worker", task: "Review this." },
		{ session, backendModel: { provider: "test-provider", id: "model-x" }, thinkingLevel: "high" },
	);
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.prepared.systemPrompt, "You are a focused reviewer.");
	session.dispose();
});

test("forge_subagent tool fails cleanly without a connected session", async () => {
	const result = await invokeSubagentTool(
		{ profile: "project:worker", task: "x" },
		{ session: undefined, backendModel: { provider: "t", id: "m" } },
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /no Forge host session/);
});
