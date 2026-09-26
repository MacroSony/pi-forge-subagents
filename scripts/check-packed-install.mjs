import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mainRoot = process.env.PI_FORGE_ROOT ?? resolve(rootDir, "../pi-forge");
const npmCli = process.env.npm_execpath;
const npm = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
const npmPrefix = npmCli ? [npmCli] : [];

function run(command, args, opts = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...opts });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
	}
	return result.stdout;
}

function packInto(cwd, into, extraArgs = []) {
	const stdout = run(npm, [...npmPrefix, "pack", "--pack-destination", into, "--json", ...extraArgs], { cwd });
	const [manifest] = JSON.parse(stdout);
	return join(into, manifest.filename);
}

const SMOKE = `
const bus = {
	listeners: new Map(),
	emit(channel, data) {
		for (const handler of [...(this.listeners.get(channel) ?? [])]) handler(data);
	},
	on(channel, handler) {
		const list = this.listeners.get(channel) ?? [];
		list.push(handler);
		this.listeners.set(channel, list);
		return () => {
			const current = this.listeners.get(channel) ?? [];
			this.listeners.set(channel, current.filter((entry) => entry !== handler));
		};
	},
};

function makePi(name) {
	const handlers = new Map();
	const commands = new Map();
	const pi = {
		events: bus,
		on(event, handler) { handlers.set(event, handler); },
		registerCommand(name, definition) { commands.set(name, definition); },
		registerTool() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools() {},
		getThinkingLevel: () => "high",
		setThinkingLevel() {},
		getModel: () => undefined,
		appendEntry() {},
	};
	return { pi, handlers, commands };
}

function makeCtx(cwd) {
	const sessionManager = {
		getLeafId: () => "leaf-1",
		getBranch: () => [],
		getEntries: () => [],
		getSessionId: () => "packed-smoke-session",
	};
	return {
		cwd,
		isProjectTrusted: () => true,
		sessionManager,
		ui: {
			notify() {},
			setStatus() {},
			theme: { fg: (_color, text) => text },
		},
		model: undefined,
		modelRegistry: {
			getAll: () => [], getAvailable: () => [], find: () => undefined, hasConfiguredAuth: () => false,
		},
		hasUI: false,
		isIdle: () => true,
	};
}

const mainModule = await import("@zihanw/pi-forge");
const optionalModule = await import("@zihanw/pi-forge-subagents");
const { DeterministicFakeBackend } = await import("@zihanw/pi-subagent-runtime/testing");
if (typeof mainModule.default !== "function") throw new Error("main default export missing");
if (typeof optionalModule.default !== "function") throw new Error("optional default export missing");

const cwd = process.env.FORGE_SMOKE_CWD;
if (!cwd) throw new Error("FORGE_SMOKE_CWD is not set");

const mainHost = makePi("main");
mainModule.default(mainHost.pi);
const optionalHost = makePi("optional");
const optionalCtx = optionalModule.default(optionalHost.pi);

// Start the main host first so discovery observes the announcement; then the
// optional extension connects its session over the shared bus.
await mainHost.handlers.get("session_start")({ reason: "new" }, makeCtx(cwd));
await optionalHost.handlers.get("session_start")({ reason: "new" }, makeCtx(cwd));

if (optionalHost.commands.has("forge")) throw new Error("optional must not register /forge");
const forge = mainHost.commands.get("forge");
if (!forge) throw new Error("main /forge command missing");
if (!mainHost.commands.has("capability")) throw new Error("packed /capability command missing");
const rootCompletions = await forge.getArgumentCompletions("sub");
if (!rootCompletions.some(item => item.value === "subagent")) throw new Error("packed optional contribution not discovered");
const nestedCompletions = await forge.getArgumentCompletions("subagent p");
if (!nestedCompletions.some(item => item.value === "subagent plan")) throw new Error("nested packed completion missing");
await forge.handler("subagent help", makeCtx(cwd));

const session = optionalCtx.session;
if (!session) throw new Error("optional extension did not establish a host session");

const profiles = await session.listProfiles();
const worker = profiles.find((profile) => profile.profileId === "worker");
if (!worker || worker.scope !== "project" || worker.usable !== true) {
	throw new Error("fixture profile not listed as usable: " + JSON.stringify(profiles));
}

const resolved = await session.resolveProfile("worker");
if (resolved.snapshot?.profileId !== "project:worker") {
	throw new Error("resolveProfile returned an unexpected snapshot");
}
if (typeof resolved.snapshot?.profileFingerprint !== "string" || !resolved.snapshot.profileFingerprint.startsWith("sha256:v1:")) {
	throw new Error("snapshot is missing a host-issued fingerprint");
}

const prepared = await session.prepare({
	profile: "worker",
	task: { text: "Verify the packed host port." },
	access: { level: "read-only", network: "deny", allowProcess: false },
	backend: {
		model: { provider: "test", id: "model" },
		thinkingLevel: "high",
		toolCatalog: [
			{ id: "tool.read", name: "read", effects: [] },
			{ id: "tool.write", name: "write", effects: [] },
		],
	},
});
if (JSON.stringify(prepared.effectiveToolNames) !== JSON.stringify(["read"])) {
	throw new Error("public prepare did not honor tools.initial: " + JSON.stringify(prepared.effectiveToolNames));
}
if (!prepared.systemPrompt.includes("PACKED-SMOKE-MARKER")) {
	throw new Error("prepare did not return the fixture system prompt: " + prepared.systemPrompt);
}
const finalMessage = prepared.messages.at(-1);
if (finalMessage?.protectedTask !== true || finalMessage?.source !== "delegated-task") {
	throw new Error("prepare did not append the protected delegated task");
}
if (finalMessage?.content?.[0]?.text !== "Verify the packed host port.") {
	throw new Error("protected task text mismatch");
}

const fakeBackend = new DeterministicFakeBackend({ id: "fake-packed", fidelity: "backend-assisted" });
const runtime = optionalModule.createForgeSubagentRuntime(() => session, {
	builtInBackends: false,
	extraBackends: [{
		descriptor: fakeBackend.descriptor,
		preflight(input) {
			const result = fakeBackend.preflight(input);
			return result.status === "accepted" ? { ...result, toolCatalog: [
				{ id: "tool.read", name: "read", effects: [] },
				{ id: "tool.write", name: "write", effects: [] },
			] } : result;
		},
		prepare: fakeBackend.prepare.bind(fakeBackend),
		start: fakeBackend.start.bind(fakeBackend),
		discard: fakeBackend.discard.bind(fakeBackend),
	}],
	intentToolCatalog: [
		{ id: "tool.read", name: "read", effects: [] },
		{ id: "tool.write", name: "write", effects: [] },
	],
});
const runtimeContext = makeCtx(cwd);
const planned = await runtime.prepare("project:worker", "Execute the packed initial plan.", runtimeContext, {
	backendId: "fake-packed",
	timeoutMs: 1_000,
});
if (!planned.ok) throw new Error("packed runtime prepare failed: " + planned.diagnostics.map((item) => item.message).join("; "));
if (JSON.stringify(planned.prepared.plan.effectiveToolIds) !== JSON.stringify(["tool.read"])) {
	throw new Error("packed runtime plan did not preserve initial selection: " + JSON.stringify(planned.prepared.plan.effectiveToolIds));
}
const executed = await runtime.execute(planned.prepared, runtimeContext);
if (executed.status !== "completed") throw new Error("packed initial execution did not complete: " + executed.status);
await runtime.dispose();
await optionalCtx.dispose();
// Shut down the main host; disposal announces the host going away, and
// reconnecting afterwards must fail.
await mainHost.handlers.get("session_shutdown")({}, makeCtx(cwd));
let rediscoveryFailed = false;
try {
	await optionalModule.ForgeHostSession.connect(bus, { defaultTimeoutMs: 250 });
} catch {
	rediscoveryFailed = true;
}
if (!rediscoveryFailed) throw new Error("host discovery unexpectedly succeeded after disposal");

console.log("optional packed install smoke ok");
`;

if (!existsSync(mainRoot)) {
	console.log("main pi-forge checkout not found; skipping optional packed smoke");
	process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "pi-forge-subagents-packed-"));
try {
	// Guard the cross-repo invariant: main's committed dist must be in sync
	// with its src, otherwise the smoke would test stale host code.
	if (existsSync(join(mainRoot, "scripts", "check-dist.mjs"))) {
		run(process.execPath, [join(mainRoot, "scripts", "check-dist.mjs")]);
	}
	// Pack main from its committed dist and this package via its prepack build
	// (dist is gitignored here).
	const mainPack = packInto(mainRoot, tmp, ["--ignore-scripts"]);
	const optionalPack = packInto(rootDir, tmp);

	const consumer = mkdtempSync(join(tmpdir(), "pi-forge-subagents-consumer-"));
	const fixture = mkdtempSync(join(tmpdir(), "pi-forge-subagents-fixture-"));
	try {
		writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "smoke-optional", private: true, type: "module" }));
		// Pin the SDK family from the packed host's peer-compatible dev versions.
		const manifest = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
		const mainManifest = JSON.parse(readFileSync(join(mainRoot, "package.json"), "utf8"));
		// The packed main host is the compatibility anchor. Its current peer SDK
		// versions may be newer than this optional checkout's dev pins.
		const pin = (name) => `${name}@${String(mainManifest.devDependencies?.[name] ?? manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]).replace(/^\^/, "")}`;
		run(npm, [...npmPrefix, "install", mainPack, optionalPack,
			pin("@earendil-works/pi-coding-agent"),
			pin("@earendil-works/pi-ai"),
			pin("@earendil-works/pi-agent-core"),
			pin("@earendil-works/pi-tui"),
			pin("typebox"),
			"--no-audit", "--no-fund", "--ignore-scripts", "--legacy-peer-deps"], { cwd: consumer });

		// Fixture workspace: one prompt stack + one profile referencing it.
		const projectDir = join(fixture, "project");
		mkdirSync(join(projectDir, ".pi", "forge", "prompt-stacks"), { recursive: true });
		mkdirSync(join(projectDir, ".pi", "forge", "agent-profiles"), { recursive: true });
		writeFileSync(join(projectDir, ".pi", "forge", "prompt-stacks", "worker.json"), JSON.stringify({
			schemaVersion: 2,
			id: "worker",
			mode: "replace",
			tools: { initial: ["read"] },
			items: [
				{ kind: "block", id: "sys", role: "system", content: "PACKED-SMOKE-MARKER system prompt." },
			],
		}));
		writeFileSync(join(projectDir, ".pi", "forge", "agent-profiles", "worker.json"), JSON.stringify({
			schemaVersion: 1,
			type: "pi-forge.agent-profile",
			id: "worker",
			model: { provider: "test", id: "model" },
			thinkingLevel: "high",
			promptStack: "worker",
		}));
		writeFileSync(join(projectDir, ".pi", "forge", "subagents.json"), JSON.stringify({
			profiles: { "project:worker": { enabled: true, backend: "fake-packed" } },
		}));
		writeFileSync(join(consumer, "smoke.mjs"), SMOKE);
		run(process.execPath, ["smoke.mjs"], {
			cwd: consumer,
			env: { ...process.env, FORGE_SMOKE_CWD: projectDir, HOME: fixture },
		});
	} finally {
		rmSync(consumer, { recursive: true, force: true });
		rmSync(fixture, { recursive: true, force: true });
	}
	console.log("optional packed install smoke: PASS");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
