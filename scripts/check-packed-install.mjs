import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Release gate: test this package against explicit, published (or explicitly
// supplied) artifacts. Nothing is skipped and peers resolve normally.
//   PI_FORGE_PACKAGE / PI_SUBAGENT_RUNTIME_PACKAGE: npm spec or tarball path.
//     Defaults are the exact floors declared in this package's dependencies.
//   PI_FORGE_ROOT: pack a local Forge checkout instead (forward-compat probe).
//   PI_TEST_VERSION / TYPEBOX_TEST_VERSION: host SDK family; defaults to the
//     development pins.
const selfManifest = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const floor = (name) => {
	const range = String(selfManifest.dependencies?.[name] ?? "");
	const exact = range.replace(/^\^/, "");
	if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(exact)) throw new Error(`cannot derive an exact floor for ${name} from ${JSON.stringify(range)}`);
	return `${name}@${exact}`;
};
const exactVersion = (label, value) => {
	if (!/^\d+\.\d+\.\d+$/.test(String(value))) throw new Error(`${label} must be an exact x.y.z version, got ${JSON.stringify(value)}`);
	return String(value);
};
const piVersion = exactVersion("PI_TEST_VERSION", process.env.PI_TEST_VERSION ?? selfManifest.devDependencies?.["@earendil-works/pi-coding-agent"]);
const typeboxVersion = exactVersion("TYPEBOX_TEST_VERSION", process.env.TYPEBOX_TEST_VERSION ?? selfManifest.devDependencies?.typebox);
const mainRoot = process.env.PI_FORGE_ROOT;
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


const tmp = mkdtempSync(join(tmpdir(), "pi-forge-subagents-packed-"));
try {
	let mainPackage = process.env.PI_FORGE_PACKAGE ?? floor("@zihanw/pi-forge");
	if (mainRoot) {
		if (!existsSync(mainRoot)) throw new Error(`PI_FORGE_ROOT does not exist: ${mainRoot}`);
		if (existsSync(join(mainRoot, "scripts", "check-dist.mjs"))) {
			run(process.execPath, [join(mainRoot, "scripts", "check-dist.mjs")]);
		}
		mainPackage = packInto(mainRoot, tmp, ["--ignore-scripts"]);
	}
	const runtimePackage = process.env.PI_SUBAGENT_RUNTIME_PACKAGE ?? floor("@zihanw/pi-subagent-runtime");
	// This package via its prepack build (dist is gitignored here).
	const optionalPack = packInto(rootDir, tmp);
	console.log(`Packed optional smoke: forge=${mainPackage} runtime=${runtimePackage} pi=${piVersion} typebox=${typeboxVersion}`);

	const consumer = mkdtempSync(join(tmpdir(), "pi-forge-subagents-consumer-"));
	const fixture = mkdtempSync(join(tmpdir(), "pi-forge-subagents-fixture-"));
	try {
		writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "smoke-optional", private: true, type: "module" }));
		run(npm, [...npmPrefix, "install", mainPackage, runtimePackage, optionalPack,
			`@earendil-works/pi-coding-agent@${piVersion}`,
			`@earendil-works/pi-ai@${piVersion}`,
			`@earendil-works/pi-agent-core@${piVersion}`,
			`@earendil-works/pi-tui@${piVersion}`,
			`typebox@${typeboxVersion}`,
			"--no-audit", "--no-fund", "--ignore-scripts"], { cwd: consumer });
		const installed = (name) => JSON.parse(readFileSync(join(consumer, "node_modules", ...name.split("/"), "package.json"), "utf8")).version;
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui"]) {
			if (installed(name) !== piVersion) throw new Error(`${name} resolved to ${installed(name)}, expected ${piVersion}`);
		}
		if (installed("typebox") !== typeboxVersion) throw new Error(`typebox resolved to ${installed("typebox")}, expected ${typeboxVersion}`);
		// TypeBox is host-provided: the optional package must not carry its own copy.
		if (existsSync(join(consumer, "node_modules", "@zihanw", "pi-forge-subagents", "node_modules", "typebox"))) {
			throw new Error("pi-forge-subagents installed a private typebox copy");
		}
		console.log(`Installed: pi-forge ${installed("@zihanw/pi-forge")}, runtime ${installed("@zihanw/pi-subagent-runtime")}, optional ${installed("@zihanw/pi-forge-subagents")}`);

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
		const isolatedEnv = { ...process.env, HOME: fixture, USERPROFILE: fixture, PI_CODING_AGENT_DIR: join(fixture, "agent") };
		writeFileSync(join(consumer, "smoke.mjs"), SMOKE);
		run(process.execPath, ["smoke.mjs"], {
			cwd: consumer,
			env: { ...isolatedEnv, FORGE_SMOKE_CWD: projectDir },
			timeout: 60_000,
		});
		writeFileSync(join(consumer, "real-chain.mjs"), readFileSync(join(rootDir, "scripts", "fixtures", "packed-real-chain.mjs")));
		console.log(run(process.execPath, ["real-chain.mjs"], {
			cwd: consumer,
			env: { ...isolatedEnv, FORGE_CHAIN_CWD: join(fixture, "real-chain") },
			timeout: 120_000,
		}).trim());
	} finally {
		rmSync(consumer, { recursive: true, force: true });
		rmSync(fixture, { recursive: true, force: true });
	}
	console.log("optional packed install smoke: PASS");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
