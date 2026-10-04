// Run from an isolated consumer after installing all three packed artifacts.
// Real Forge compiler + real optional extension + real parent/child AgentSessions;
// only provider transport is synthetic (no external model service).
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage,
  fauxToolCall, getCurrentTools, getCurrentSystemPrompt, InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
  AgentSession, createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import forge from "@zihanw/pi-forge";
import subagents from "@zihanw/pi-forge-subagents";

const cwd = process.env.FORGE_CHAIN_CWD;
assert.ok(cwd);
const provider = "packed-chain";
const modelId = "fixture";
const receipt = {
  input: 11, output: 7, cacheRead: 5, cacheWrite: 2, totalTokens: 25,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0.004, total: 0.037 },
};
const configDir = join(cwd, ".pi", "forge");
const target = join(cwd, "target");
mkdirSync(target, { recursive: true });
writeFileSync(join(target, "relative.txt"), "TARGET-CWD-CONTENT");
writeFileSync(join(cwd, "relative.txt"), "WRONG-PARENT-CWD");
for (const [id, initial] of [["read-worker", ["read"]], ["empty-worker", []]]) {
  mkdirSync(join(configDir, "prompt-stacks"), { recursive: true });
  mkdirSync(join(configDir, "agent-profiles"), { recursive: true });
  writeFileSync(join(configDir, "prompt-stacks", `${id}.json`), JSON.stringify({
    schemaVersion: 2, id, mode: "replace", tools: { initial },
    items: [{ kind: "block", id: "system", role: "system", content: "PACKED-REAL-CHILD" }],
  }));
  writeFileSync(join(configDir, "agent-profiles", `${id}.json`), JSON.stringify({
    schemaVersion: 1, type: "pi-forge.agent-profile", id,
    model: { provider, id: modelId }, thinkingLevel: "medium", promptStack: id,
  }));
}
writeFileSync(join(configDir, "subagents.json"), JSON.stringify({
  allowAgentInvocationWithoutApproval: true, allowedWorkingDirectories: [target],
  profiles: Object.fromEntries(["read-worker", "empty-worker"].map((id) =>
    [`project:${id}`, { enabled: true, backend: "pi-inprocess" }])),
}));
const faux = createFauxCore({ api: provider, provider, models: [{ id: modelId, name: modelId, reasoning: true }] });
const transcripts = [];
let parkCancelledChild = false;
let onChildParked;
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerProvider(provider, {
  api: provider, baseUrl: "https://packed-chain.invalid", apiKey: "synthetic-only",
  models: [{ id: modelId, name: modelId, reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 4_000 }],
  streamSimple(model, context, options) {
    transcripts.push({ system: getCurrentSystemPrompt(context.messages),
      tools: (getCurrentTools(context.messages) ?? []).map((tool) => tool.name),
      messages: structuredClone(context.messages) });
    // Park the second child request after a real, billed read-tool turn. This
    // gives cancellation a deterministic partial-usage receipt to preserve.
    if (parkCancelledChild && context.messages.some((m) => m.role === "toolResult" && m.toolCallId === "cancel-read")) {
      const stream = createAssistantMessageEventStream();
      const abort = () => {
        const message = { role: "assistant", content: [], api: model.api,
          provider: model.provider, model: model.id, stopReason: "aborted",
          errorMessage: "synthetic request cancelled", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
      };
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener("abort", abort, { once: true });
      onChildParked?.();
      return stream;
    }
    const source = faux.streamSimple(model, context, options);
    const stream = createAssistantMessageEventStream();
    void (async () => {
      for await (const event of source) {
        if (event.type === "done") {
          const message = { ...event.message, usage: structuredClone(receipt) };
          stream.push({ ...event, message }); stream.end(message); return;
        }
        stream.push(event);
      }
      stream.end(await source.result());
    })().catch((error) => stream.end({ role: "assistant", content: [], api: model.api,
      provider: model.provider, model: model.id, usage: structuredClone(receipt),
      stopReason: "error", errorMessage: String(error), timestamp: Date.now() }));
    return stream;
  },
});
const tools = new Map();
let optional;
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
settingsManager.setProjectTrusted(true);
const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: join(cwd, "agent"), settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  systemPrompt: "PACKED-REAL-PARENT",
  extensionFactories: [forge, (pi) => {
    optional = subagents(new Proxy(pi, { get(object, key) {
      if (key === "registerTool") return (tool) => { tools.set(tool.name, tool); return pi.registerTool(tool); };
      return Reflect.get(object, key);
    } }));
  }],
});
await resourceLoader.reload();
assert.deepEqual(resourceLoader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"),
  modelRuntime, model: faux.getModel(), thinkingLevel: "medium", resourceLoader,
  sessionManager, settingsManager, tools: ["forge_subagent", "forge_subagent_task"] });
const originalDispose = AgentSession.prototype.dispose;
const extensionErrors = [];
await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
const ctx = () => session.extensionRunner.createContext();
let callNo = 0;
const call = (name, params) => tools.get(name).execute(`direct-${++callNo}`, params, undefined, undefined, ctx());
const run = (params) => call("forge_subagent", { profileId: "project:read-worker", ...params });
const task = (action, id) => call("forge_subagent_task", { action, id });
const waitForTask = async (id) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await task("status", id);
    assert.notEqual(result.details.status, "failed", JSON.stringify(result));
    const status = result.details.tasks?.[0]?.status;
    if (status && status !== "starting" && status !== "running") return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`background did not settle: ${id}`);
};
const resultMessages = () => sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "toolResult").map((e) => e.message);
const assertReceipt = (result) => {
  assert.deepEqual(result.usage, receipt);
  assert.deepEqual(result.details.forgeNestedUsage, { schemaVersion: 1, requests: 1, input: 11, output: 7, cacheRead: 5, cacheWrite: 2 });
};
function failNextChildDispose() {
  let failures = 0;
  AgentSession.prototype.dispose = function () {
    if (this !== session && failures++ === 0) throw new Error("packed injected child cleanup failure");
    return originalDispose.call(this);
  };
}
try {
  assert.ok(optional.session, "actual SDK session_start must discover the real Forge host");
  // Real host policy -> exact child tool surface, relative paths and retained history.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read", { path: "relative.txt" }, { id: "relative-read" })),
    fauxAssistantMessage("FIRST-RETAINED-ANSWER"), fauxAssistantMessage("CONTINUED-ANSWER"),
  ]);
  const first = await run({ task: "FIRST-RETAINED-TASK", cwd: target, keepContext: true });
  assert.equal(first.details.status, "completed", JSON.stringify(first));
  assert.equal(first.details.response.usage.requests.total, 2);
  const continuationId = first.details.response.continuationId;
  assert.equal(typeof continuationId, "string");
  const continued = await run({ task: "SECOND-RETAINED-TASK", cwd: target, continueId: continuationId });
  assert.equal(continued.details.status, "completed", JSON.stringify(continued));
  assert.equal(continued.details.response.continuationId, continuationId);
  assertReceipt(continued);
  const history = transcripts.at(-1);
  assert.match(history.system, /PACKED-REAL-CHILD/);
  assert.deepEqual(history.tools, ["read"]);
  for (const text of ["FIRST-RETAINED-TASK", "FIRST-RETAINED-ANSWER", "SECOND-RETAINED-TASK", "TARGET-CWD-CONTENT"]) {
    assert.equal(history.messages.filter((m) => JSON.stringify(m.content).includes(text)).length, 1, text);
  }
  assert.equal(history.messages.filter((m) => m.role === "toolResult" && m.toolCallId === "relative-read").length, 1);
  assert.ok(!JSON.stringify(history).includes("WRONG-PARENT-CWD"));
  await task("release", continuationId);
  assert.equal((await task("release", continuationId)).details.status, "failed");

  faux.setResponses([fauxAssistantMessage("NO-TOOLS-ANSWER")]);
  const empty = await run({ profileId: "project:empty-worker", task: "No tool defaults" });
  assert.equal(empty.details.status, "completed", JSON.stringify(empty));
  assert.deepEqual(transcripts.at(-1).tools, []);
  assertReceipt(empty);

  // Foreground cleanup failure must survive the actual parent SDK tool loop.
  failNextChildDispose();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("forge_subagent", { profileId: "project:empty-worker", task: "cleanup foreground" }, { id: "fg-cleanup" })),
    fauxAssistantMessage("BILLED-BEFORE-CLEANUP"), fauxAssistantMessage("PARENT-DONE"),
  ]);
  await session.prompt("Delegate a foreground child.");
  await session.waitForIdle();
  AgentSession.prototype.dispose = originalDispose;
  const foreground = resultMessages().at(-1);
  assert.equal(foreground.details.status, "failed", JSON.stringify(foreground));
  assert.equal(foreground.details.response.error.code, "inprocess-cleanup");
  assertReceipt(foreground);
  assert.equal(session.getSessionStats().tokens.total, 75, "two parent requests plus failed child receipt");

  // Background cleanup failure: launch/status carry no credit, only first result does.
  failNextChildDispose();
  faux.setResponses([fauxAssistantMessage("BACKGROUND-BILLED-BEFORE-CLEANUP")]);
  const launch = await run({ task: "cleanup background", background: true });
  assert.equal(launch.usage, undefined);
  assert.equal(launch.details.forgeNestedUsage, undefined);
  assert.equal(await waitForTask(launch.details.runId), "failed");
  AgentSession.prototype.dispose = originalDispose;
  // Two successive parent tool calls must persist exactly one receipt in JSONL.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("forge_subagent_task", { action: "result", id: launch.details.runId }, { id: "bg-first" })),
    fauxAssistantMessage(fauxToolCall("forge_subagent_task", { action: "result", id: launch.details.runId }, { id: "bg-second" })),
    fauxAssistantMessage("PARENT-COLLECTED"),
  ]);
  await session.prompt("Collect the finished background result twice.");
  await session.waitForIdle();
  const results = resultMessages();
  assert.equal(results.length, 3);
  assert.equal(results[1].details.response.error.code, "inprocess-cleanup");
  assert.equal(results[1].details.usageCredited, true);
  assertReceipt(results[1]);
  assert.equal(results[2].details.usageCredited, false);
  assert.equal(results[2].usage, undefined);
  assert.equal(results[2].details.forgeNestedUsage, undefined);
  assert.equal(session.getSessionStats().tokens.total, 175, "5 parent + 2 child receipts, not 8");
  assert.ok(Math.abs(session.getSessionStats().cost - 7 * receipt.cost.total) < 1e-12);
  const reopened = SessionManager.open(sessionManager.getSessionFile());
  const summarize = (await import(new URL("./session-usage.js", import.meta.resolve("@zihanw/pi-forge")).href)).summarizeSessionCacheUsage;
  const view = summarize(reopened.getBranch());
  assert.equal(view.main.session.requests, 5);
  assert.equal(view.nested.session.requests, 2);
  assert.equal(view.nested.session.calls, 2);
  assert.equal(view.nested.session.input, 22);
  assert.equal(view.nested.session.cacheRead, 10);

  // Cancellation after a billed turn: pending inspection cannot claim usage;
  // the first terminal collection persists the partial receipt exactly once.
  const parked = new Promise((resolve) => { onChildParked = resolve; });
  parkCancelledChild = true;
  faux.setResponses([fauxAssistantMessage(fauxToolCall("read", { path: "relative.txt" }, { id: "cancel-read" }))]);
  const cancelLaunch = await run({ task: "cancel after one billed turn", cwd: target, background: true });
  assert.equal(cancelLaunch.details.background, true, JSON.stringify(cancelLaunch));
  let timer;
  try {
    await Promise.race([parked, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("child did not park")), 10_000); })]);
  } finally { clearTimeout(timer); }
  const pending = await task("result", cancelLaunch.details.runId);
  assert.equal(pending.details.usageCredited, false);
  assert.equal(pending.details.task.collected, false);
  assert.equal(pending.usage, undefined);
  await task("cancel", cancelLaunch.details.runId);
  assert.equal(await waitForTask(cancelLaunch.details.runId), "cancelled");
  parkCancelledChild = false;
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("forge_subagent_task", { action: "result", id: cancelLaunch.details.runId }, { id: "cancel-first" })),
    fauxAssistantMessage(fauxToolCall("forge_subagent_task", { action: "result", id: cancelLaunch.details.runId }, { id: "cancel-second" })),
    fauxAssistantMessage("PARENT-CANCEL-COLLECTED"),
  ]);
  await session.prompt("Collect the cancelled child's partial usage twice.");
  await session.waitForIdle();
  const cancelled = resultMessages().slice(-2);
  assert.equal(cancelled[0].details.response.status, "cancelled");
  assert.equal(cancelled[0].details.usageCredited, true);
  assert.deepEqual(cancelled[0].usage, receipt, "only the completed first request carries tokens");
  assert.equal(cancelled[1].details.usageCredited, false);
  assert.equal(cancelled[1].usage, undefined);
  assert.equal(cancelled[1].details.forgeNestedUsage, undefined);
  assert.equal(session.getSessionStats().tokens.total, 275, "8 parent + 3 nonzero child receipts");
  const cancelledView = summarize(SessionManager.open(sessionManager.getSessionFile()).getBranch());
  assert.equal(cancelledView.main.session.requests, 8);
  assert.equal(cancelledView.nested.session.calls, 3);
  assert.equal(cancelledView.nested.session.requests, 2 + cancelled[0].details.response.usage.requests.total);
  assert.equal(cancelledView.nested.session.input, 33);
  assert.deepEqual(extensionErrors, []);
  console.log("real packed chain: PASS (real Forge + SDK parent/child; initial read/empty, target relative read, retained history, cleanup/cancellation usage once, pending collection, JSONL)");
} finally {
  AgentSession.prototype.dispose = originalDispose;
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
  optional?.dispose();
  session.dispose();
  modelRuntime.unregisterProvider(provider);
}
