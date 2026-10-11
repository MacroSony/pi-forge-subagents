// Packed acceptance: real Forge/Subagents/runtime + parent/child AgentSessions.
// Offline deterministic provider; no mock backend, credentials or real provider requests.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import * as sdk from "@earendil-works/pi-coding-agent";
import * as ai from "@earendil-works/pi-ai";
import { Type } from "typebox";
import forge from "@zihanw/pi-forge";
import optional from "@zihanw/pi-forge-subagents";
import { parseForgeNestedUsage } from "@zihanw/pi-forge/subagent";
const cwd = process.env.FORGE_USAGE_CWD;
assert(cwd, "FORGE_USAGE_CWD must be an isolated test workspace");
const out = path.join(cwd, 'acceptance-output'), agent = path.join(out, 'agent');
for (const p of [cwd, out, agent, path.join(out, 'home')])
    fs.mkdirSync(p, { recursive: true });
process.env.HOME = path.join(out, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_FORGE_GLOBAL_DIR = path.join(out, 'global-forge');
const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
const { createAssistantMessageEventStream, createFauxCore, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = ai;
sdk.initTheme?.('dark');
const hasCodemode = typeof createCodemodeExtension === 'function';
const dir = path.join(cwd, '.pi/forge');
for (const d of ['prompt-stacks', 'agent-profiles'])
    fs.mkdirSync(path.join(dir, d), { recursive: true });
const provider = 'usage-notify-acceptance', api = 'usage-notify-acceptance-api';
for (const name of ['blue', 'green']) {
    fs.writeFileSync(path.join(dir, 'prompt-stacks', name + '.json'), JSON.stringify({ schemaVersion: 2, id: name, tools: { initial: [] }, items: [{ kind: 'block', id: 'worker', role: 'system', content: 'ACCEPTANCE-CHILD ' + name }] }));
    fs.writeFileSync(path.join(dir, 'agent-profiles', name + '.json'), JSON.stringify({ schemaVersion: 1, type: 'pi-forge.agent-profile', id: name, model: { provider, id: name }, thinkingLevel: 'medium', promptStack: name }));
}
const config = { allowAgentInvocationWithoutApproval: true, notifyOnComplete: true, profiles: Object.fromEntries(['blue', 'green'].map(n => ['project:' + n, { enabled: true, backend: 'pi-inprocess' }])) };
const saveConfig = () => fs.writeFileSync(path.join(dir, 'subagents.json'), JSON.stringify(config));
saveConfig();
const receipt = { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, totalTokens: 25, cost: { input: .01, output: .02, cacheRead: .003, cacheWrite: .004, total: .037 } };
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let phase = 'bootstrap', childGate = Promise.resolve(), releaseChild = () => { }, holdGate = Promise.resolve(), releaseHold = () => { }, holdEntered = false;
let queue = [], parentRequests = 0, childRequests = 0, session;
const transcript = [];
const errors = [];
const events = [];
const oldLog = console.log;
const deferChild = () => { childGate = new Promise(r => releaseChild = r); };
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
modelRuntime.registerProvider(provider, { api, apiKey: 'offline-fixture', baseUrl: 'https://offline.invalid', models: ['parent', 'blue', 'green'].map(id => ({ id, name: id, reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 })), streamSimple(model, context, options) {
        const isParent = model.id === 'parent';
        const turn = { phase, model: model.id, parent: isParent, messages: structuredClone(context.messages) };
        transcript.push(turn);
        const item = isParent ? queue.shift() : () => fauxAssistantMessage('CHILD-OK-' + model.id);
        if (isParent) {
            parentRequests++;
            assert(parentRequests < 40, 'parent request budget');
            assert(item, 'Unexpected parent request/wake in phase ' + phase);
        }
        else
            childRequests++;
        const chosen = typeof item === 'function' ? item() : item;
        const core = createFauxCore({ api, provider, models: [{ id: model.id, name: model.id, reasoning: true }] });
        core.setResponses([chosen]);
        const target = createAssistantMessageEventStream();
        void (async () => { if (!isParent)
            await childGate; const source = core.streamSimple(model, context, options); for await (const e of source) {
            if (e.type === 'done') {
                const m = { ...e.message, usage: structuredClone(isParent ? zero : receipt) };
                target.push({ ...e, message: m });
                target.end(m);
                return;
            }
            target.push(e);
        } target.end(await source.result()); })().catch(e => { errors.push(String(e.stack ?? e)); const m = { role: 'assistant', content: [], api, provider, model: model.id, usage: zero, stopReason: 'error', errorMessage: String(e), timestamp: Date.now() }; target.push({ type: 'error', reason: 'error', error: m }); target.end(m); });
        return target;
    } });
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
settings.setProjectTrusted(true);
const manager = SessionManager.create(cwd, path.join(out, 'sessions'));
// All extensions and SDK peers come from the packed isolated consumer.
const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'ACCEPTANCE-PARENT', extensionFactories: [forge, optional, ...(hasCodemode ? [createCodemodeExtension({ models: false })] : []), (pi) => {
            pi.registerTool({ name: 'acceptance_hold', label: 'Hold', description: 'Deterministic test barrier', parameters: Type.Object({}), execute: async () => { holdEntered = true; await holdGate; return { content: [{ type: 'text', text: 'HOLD-RELEASED' }] }; } });
            pi.on('tool_result', e => { events.push({ type: 'tool_result', tool: e.toolName, id: e.toolCallId, parent: e.parentToolCallId, details: e.details }); });
        }] });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const created = await createAgentSession({ cwd, agentDir: agent, resourceLoader: loader, modelRuntime, model: modelRuntime.getModels(provider).find(m => m.id === 'parent'), thinkingLevel: 'medium', sessionManager: manager, settingsManager: settings, tools: ['forge_subagent', 'forge_subagent_task', 'acceptance_hold', ...(hasCodemode ? ['codemode'] : [])] });
session = created.session;
await session.bindExtensions({ onError: e => errors.push(e) });
session.subscribe(e => { if (e.type === 'message_start' && e.message.role === 'custom')
    events.push({ type: 'custom', ...e.message }); if (e.type === 'extension_error')
    errors.push(e); });
const resultMessages = () => manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'toolResult').map(e => e.message);
const lastLaunch = () => resultMessages().filter(m => m.toolName === 'forge_subagent' && m.details?.background).at(-1)?.details?.runId;
let directId = 0;
async function call(name, args) { return session.extensionRunner.getToolDefinition(name).execute('inspection-' + (++directId), args, undefined, undefined, session.extensionRunner.createContext()); }
const wait = async (predicate, label) => { const deadline = Date.now() + 15000; while (Date.now() < deadline) {
    if (await predicate())
        return;
    await new Promise(r => setTimeout(r, 15));
} throw Error('Timeout: ' + label); };
const customCount = () => events.filter(e => e.type === 'custom' && e.customType === 'forge-subagent-completion').length;
const launch = (name, extra = {}) => () => fauxAssistantMessage(fauxToolCall('forge_subagent', { profileId: 'project:' + name, task: 'Return CHILD-OK-' + name, background: true, ...extra }, { id: 'launch-' + phase }));
const collect = () => fauxAssistantMessage(fauxToolCall('forge_subagent_task', { action: 'result', id: lastLaunch() }, { id: 'collect-' + phase }));
const done = () => fauxAssistantMessage('PARENT-DONE-' + phase);
const checks = [];
let summary;
try {
    // Idle completion wakes exactly once and the model collects on the actual SDK loop.
    phase = 'idle';
    deferChild();
    queue = [launch('blue'), done, collect, done];
    await session.prompt('Run idle notification acceptance');
    await session.waitForIdle();
    assert.equal(queue.length, 2);
    assert(lastLaunch());
    assert.equal(customCount(), 0);
    const id1 = lastLaunch();
    releaseChild();
    await wait(() => queue.length === 0 && !session.isStreaming, 'idle notification result');
    assert.equal(customCount(), 1);
    assert(resultMessages().some(m => m.toolName === 'forge_subagent_task' && m.details.usageCredited === true));
    checks.push('idle auto wake + collection');
    // While busy, completion waits for the current tool batch, not a concurrent prompt.
    phase = 'busy';
    deferChild();
    holdEntered = false;
    holdGate = new Promise(r => releaseHold = r);
    const n = customCount();
    queue = [launch('green'), () => fauxAssistantMessage(fauxToolCall('acceptance_hold', {}, { id: 'hold-busy' })), collect, done];
    const busy = session.prompt('Run busy notification acceptance');
    await wait(() => holdEntered, 'hold tool entered');
    releaseChild();
    await wait(async () => { const r = await call('forge_subagent_task', { action: 'status', id: lastLaunch() }); return r.details.tasks[0]?.status === 'completed'; }, 'busy child completed');
    await new Promise(r => setTimeout(r, 100));
    assert.equal(queue.length, 2, 'steering must not start another parent while hold tool is unfinished');
    releaseHold();
    await busy;
    await wait(() => queue.length === 0 && !session.isStreaming, 'busy steering collection');
    assert.equal(customCount(), n + 1);
    checks.push('busy steering after tool batch');
    // Both levels independently prevent wakes; a per-run true cannot override the master.
    for (const [scenario, master, extra] of [["master-off", false, { notifyOnComplete: true }], ["per-run-off", true, { notifyOnComplete: false }]]) {
        phase = scenario;
        config.notifyOnComplete = master;
        saveConfig();
        deferChild();
        const before = customCount();
        queue = [launch('blue', extra), done];
        await session.prompt('Run master-off notification acceptance');
        await session.waitForIdle();
        const offId = lastLaunch();
        releaseChild();
        await wait(async () => { const r = await call('forge_subagent_task', { action: 'status', id: offId }); return r.details.tasks[0]?.status === 'completed'; }, 'silent child complete');
        await new Promise(r => setTimeout(r, 100));
        assert.equal(customCount(), before);
        const captured = [];
        console.log = (...args) => captured.push(args.join(' '));
        try {
            const c = session.extensionRunner.createCommandContext();
            await session.extensionRunner.getCommand('forge-agent').handler('usage', c);
        }
        finally {
            console.log = oldLog;
        }
        assert(captured.join('\n').includes('completed/uncollected'));
        const status = await call('forge_subagent_task', { action: 'status', id: offId });
        assert.equal(status.details.tasks[0].collected, false);
        fs.writeFileSync(path.join(out, scenario + '-usage-before-collection.txt'), captured.join('\n'));
        queue = [collect, done];
        await session.prompt('Collect previously silent task');
        await session.waitForIdle();
        checks.push(scenario + ' + read-only pending usage');
    }
    config.notifyOnComplete = true;
    saveConfig();
    // Actual child execution, not a substituted/mock runtime response.
    phase = 'wrapped';
    childGate = Promise.resolve();
    queue = [() => fauxAssistantMessage(hasCodemode
            ? fauxToolCall('codemode', { code: 'const results = await Promise.all([tools.forge_subagent({profileId:"project:blue",task:"Return CHILD-OK-blue"}), tools.forge_subagent({profileId:"project:green",task:"Return CHILD-OK-green"})]); text(results);' }, { id: 'wrapper' })
            : [fauxToolCall('forge_subagent', { profileId: 'project:blue', task: 'Return CHILD-OK-blue' }, { id: 'direct-blue' }), fauxToolCall('forge_subagent', { profileId: 'project:green', task: 'Return CHILD-OK-green' }, { id: 'direct-green' })]), done];
    await session.prompt('Run accounting acceptance');
    await session.waitForIdle();
    const accountingResults = resultMessages().filter(m => hasCodemode ? m.toolCallId === 'wrapper' : ['direct-blue', 'direct-green'].includes(m.toolCallId));
    assert.equal(accountingResults.length, hasCodemode ? 1 : 2);
    assert.equal(accountingResults.reduce((n, m) => n + m.usage.totalTokens, 0), 50);
    assert.equal(accountingResults.reduce((n, m) => n + m.details.forgeNestedUsage.requests, 0), 2);
    const receipts = accountingResults.flatMap(m => m.details.forgeSubagentUsage.runs);
    assert.equal(receipts.length, 2);
    assert.equal(new Set(receipts.map(r => r.taskId)).size, 2, 'do not truncate distinct short task IDs into the same namespace');
    const executionEvents = events.filter(e => e.type === 'tool_result' && e.tool === 'forge_subagent' && (hasCodemode ? e.parent === 'wrapper' : ['direct-blue', 'direct-green'].includes(e.id)));
    assert.equal(executionEvents.length, 2);
    for (const e of executionEvents)
        assert(receipts.some(r => r.taskId === e.details.response.runId), 'receipt must preserve the usable entire task handle');
    checks.push((hasCodemode ? 'codemode nested' : 'old-host direct') + ' actual child + distinct handles + exact native/nested usage');
    const reopened = SessionManager.open(manager.getSessionFile()).getBranch();
    const totals = reopened.filter(e => e.type === 'message' && e.message.role === 'toolResult').map(e => parseForgeNestedUsage(e.message.details?.forgeNestedUsage)).filter(Boolean).reduce((sum, r) => ({ requests: sum.requests + r.requests, input: sum.input + r.input }), { requests: 0, input: 0 });
    assert.equal(totals.requests, 6);
    assert.equal(totals.input, 66);
    assert.equal(session.getSessionStats().tokens.total, 150);
    const capturedAfter = [];
    console.log = (...args) => capturedAfter.push(args.join(' '));
    try {
        await session.extensionRunner.getCommand('forge-agent').handler('usage', session.extensionRunner.createCommandContext());
    }
    finally {
        console.log = oldLog;
    }
    fs.writeFileSync(path.join(out, 'usage-after.txt'), capturedAfter.join('\n'));
    assert(capturedAfter.join('\n').includes(provider + '/blue'));
    assert(capturedAfter.join('\n').includes(provider + '/green'));
    assert(capturedAfter.join('\n').includes(id1));
    assert.deepEqual(errors, []);
    summary = { pass: true, hasCodemode, checks, parentRequests, childRequests, notifications: customCount(), native: session.getSessionStats(), forge: totals };
}
catch (e) {
    summary = { pass: false, error: String(e.stack ?? e), checks, parentRequests, childRequests, errors };
    process.exitCode = 1;
}
finally {
    console.log = oldLog;
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 2));
    fs.writeFileSync(path.join(out, 'requests.json'), JSON.stringify(transcript, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    releaseChild();
    releaseHold();
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' });
    session.dispose();
}
