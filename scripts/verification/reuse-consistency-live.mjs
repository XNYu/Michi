#!/usr/bin/env node
/**
 * Real production-route acceptance. No mock server, injected runtime, or user DB.
 * Preparation: --help / --preflight (CLI --version and allowlisted config only).
 * Execution requires explicit loopback base and isolated paths; see adjacent README.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? fallback : argv[at + 1];
};
const CASES = ['stream-io', 'recovery', 'cancel', 'fork', 'user-input', 'bootstrap', 'metadata', 'run-queued', 'run-immediate', 'scheduled-isolation'];
if (flag('help') || argv.length === 0) {
  fs.writeSync(1, `Usage:
  node scripts/verification/reuse-consistency-live.mjs --preflight [--config-dir DIR]
  node scripts/verification/reuse-consistency-live.mjs --execute --ack-isolated \\
    --base http://127.0.0.1:PORT --artifact-temp-folder /tmp/michi-live-TASK \\
    --data-dir /tmp/michi-live-TASK/data --config-dir /tmp/michi-live-TASK/config \\
    --runtimes claude,codex,kiro,pi [--profiles PUBLIC_PROFILES.json] \\
    [--cases ${CASES.join(',')}] [--target-runtime claude] [--timeout-ms 180000]
  Extra cases: exact-reply, source-warning, restart-seed, restart-verify. Use --resume-manifest PATH for verify.
  Existing Crew setup only: --runtimes crew --cases exact-reply --allow-existing-crew
  --cleanup-only --resume-manifest PATH cancels only handles recorded by that run.
  No application processes are started or killed. Evidence and test workspaces remain.`);
  process.exit(0);
}

const safeConfig = configDir => {
  const file = path.join(configDir, 'config.json');
  if (!fs.existsSync(file)) return { configDir, exists: false };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const agent = raw.agent ?? {};
  const keys = ['runtime', 'provider', 'providerByRuntime', 'modelByRuntime', 'reasoningByRuntime', 'nativeResumeByRuntime', 'nativeForkByRuntime', 'claudeConfigDir'];
  return { configDir, exists: true, agent: Object.fromEntries(keys.filter(k => k in agent).map(k => [k, agent[k]])), configuredProviderNames: Object.keys(raw.providerApiKeys ?? {}) };
};
const safeCrewPreflight = () => {
  const home = process.env.KIROCREW_HOME || path.join(os.homedir(), '.kiro', 'crew');
  const app = process.env.MICHI_CREW_APP || 'michi-crew-runtime';
  const dir = path.join(home, 'apps', app);
  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
  const manifest = readJson(path.join(dir, 'app.json'));
  const installed = readJson(path.join(dir, 'installed.json'));
  const gateway = readJson(path.join(home, 'config.json')).mcp_gateway ?? {};
  const stub = `${app}:michi`;
  return { app, homePresent: fs.existsSync(home), appSecretFilePresent: fs.existsSync(path.join(dir, '.app_secret')), installedVersion: manifest.version ?? null, expectedVersion: readJson(new URL('../../crew-app/app.json', import.meta.url)).version ?? null, enabled: installed.enabled === true, sessionApprovalDeclared: manifest.permissions?.sessionApproval === true, sessionApprovalConsentPending: installed.sessionApprovalConsentPending === true, mcpDeclared: !!manifest.mcpServers?.michi, mcpRouted: gateway.stub_overrides?.[stub] ?? gateway.stub_servers?.includes(stub) ?? false, note: 'Offline fields only. No secret content, account creation, consent, Gateway connection, or Crew session.' };
};
if (flag('preflight')) {
  const binaries = ['node', 'claude', 'codex', 'kiro-cli', 'pi'].map(binary => {
    const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 8_000 });
    return { binary, available: !result.error && result.status === 0, version: result.stdout?.trim().slice(0, 240) || null, errorCode: result.error?.code ?? null };
  });
  const configDirs = arg('config-dir') ? [arg('config-dir')] : [path.join(os.homedir(), '.michi'), path.join(os.homedir(), '.michi-dev')];
  fs.writeSync(1, `${JSON.stringify({ mode: 'read-only-preflight', binaries, configs: configDirs.map(safeConfig), codexAuthFilePresent: fs.existsSync(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'auth.json')), crew: safeCrewPreflight(), note: 'No credential values, provider calls, application startup, or chat database reads.' }, null, 2)}\n`);
  process.exit(0);
}

assert(flag('execute') || flag('cleanup-only'), '--execute or --cleanup-only is required');
assert(flag('ack-isolated'), '--ack-isolated confirms root supplied disposable data/config paths');
const base = new URL(arg('base'));
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && base.protocol === 'http:', 'Only explicit loopback HTTP backend accepted');
const artifactRoot = fs.realpathSync(arg('artifact-temp-folder'));
assert(artifactRoot !== '/' && artifactRoot !== os.homedir() && /(?:tmp|temp|artifact)/i.test(artifactRoot), 'Use a dedicated artifact temporary folder');
const inside = candidate => {
  const rel = path.relative(artifactRoot, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const dataDir = fs.realpathSync(arg('data-dir'));
const configDir = fs.realpathSync(arg('config-dir'));
assert(inside(dataDir) && inside(configDir) && dataDir !== configDir, 'Both data/config directories must be separate descendants of artifact-temp-folder');
assert(![path.join(os.homedir(), '.michi'), path.join(os.homedir(), '.michi-dev')].includes(dataDir), 'User data directories forbidden');
const dbPath = path.join(dataDir, 'data.db');
assert(fs.existsSync(dbPath), 'Root must start the real backend and initialize isolated SQLite first');
const timeoutMs = Number(arg('timeout-ms', '180000'));
assert(Number.isFinite(timeoutMs) && timeoutMs >= 15_000 && timeoutMs <= 900_000);
const resumePath = arg('resume-manifest');
const state = resumePath ? JSON.parse(fs.readFileSync(resumePath, 'utf8')) : {
  version: 1, id: `live-reuse-${Date.now()}-${randomUUID().slice(0, 8)}`, base: base.origin,
  dataDir, configDir, artifactRoot, chats: [], runs: [], jobs: [], definitions: [], workspaces: [], restartSeeds: [], results: [],
};
const initialResultCount = state.results.length;
assert.equal(state.base, base.origin, 'Manifest backend must match');
assert.equal(state.dataDir, dataDir, 'Manifest data directory must match');
assert.equal(state.artifactRoot, artifactRoot, 'Manifest artifact folder must match');
const runDir = resumePath ? path.dirname(fs.realpathSync(resumePath)) : path.join(artifactRoot, state.id);
assert(inside(runDir));
fs.mkdirSync(runDir, { recursive: true });
const manifestPath = path.join(runDir, 'manifest.json');
const save = () => fs.writeFileSync(manifestPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
const writeEvidence = (name, value) => fs.writeFileSync(path.join(runDir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const db = new DatabaseSync(dbPath, { readOnly: true });
db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
let shuttingDown = false;
const controllers = new Set();
const api = async (method, route, body, options = {}) => {
  const response = await fetch(new URL(`/api${route}`, base), {
    method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-idempotency-key': `${state.id}-${randomUUID()}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const text = await response.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { responseText: text.slice(0, 500) }; }
  if (!response.ok && !options.allowStatuses?.includes(response.status)) throw new Error(`${method} ${route}: HTTP ${response.status}: ${JSON.stringify(data)}`);
  return options.withStatus ? { status: response.status, data } : data;
};
const poll = async (label, test, budget = timeoutMs) => {
  const end = Date.now() + budget;
  while (!shuttingDown && Date.now() < end) { const value = await test(); if (value) return value; await delay(300); }
  throw new Error(`Timed out: ${label}`);
};
const queryNode = nodeId => {
  assert(state.chats.some(c => c.nodeId === nodeId) || state.workspaces.some(w => w.scheduledNodeIds?.includes(nodeId)), 'Only this manifest\'s nodes may be read');
  return {
    node: db.prepare('SELECT * FROM nodes WHERE id = ?').get(nodeId),
    messages: db.prepare('SELECT * FROM messages WHERE node_id = ? ORDER BY seq').all(nodeId),
    turns: db.prepare('SELECT * FROM turns WHERE node_id = ? ORDER BY started_at').all(nodeId),
  };
};
const snapshot = async (chat, label) => {
  const http = await api('GET', `/workspaces/${chat.workspaceId}`);
  const sqlite = queryNode(chat.nodeId);
  assert(http.nodes.some(n => n.id === chat.nodeId), 'HTTP hydration must contain node');
  writeEvidence(`${label}.persistence.json`, { http, sqlite });
  return sqlite;
};
const observeStream = async (route, body, label, onEvent, externalController) => {
  const controller = externalController ?? new AbortController();
  controllers.add(controller);
  const timer = setTimeout(() => controller.abort(new Error(`Stream timeout: ${label}`)), timeoutMs);
  const events = [];
  const output = fs.createWriteStream(path.join(runDir, `${label}.sse.jsonl`), { mode: 0o600 });
  try {
    let response;
    const deadline = Date.now() + timeoutMs;
    // Only a confirmed turn_active means the serialized request provably never began.
    while (true) {
      response = await fetch(new URL(`/api${route}`, base), { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal });
      if (response.ok) break;
      const error = await response.json();
      if (response.status === 409 && error.code === 'turn_active' && Date.now() < deadline) { await delay(250); continue; }
      throw new Error(`${route}: HTTP ${response.status}: ${JSON.stringify(error)}`);
    }
    assert(response.headers.get('content-type')?.includes('text/event-stream'), 'Real route must return SSE');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frame = async raw => {
      const lines = raw.split('\n');
      const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
      const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!event || !data) return;
      const item = { event, data: JSON.parse(data), receivedAt: Date.now() };
      events.push(item); output.write(`${JSON.stringify(item)}\n`);
      await onEvent?.(item, events);
    };
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let index; while ((index = buffer.indexOf('\n\n')) >= 0) { const raw = buffer.slice(0, index); buffer = buffer.slice(index + 2); await frame(raw); }
      if (done) break;
    }
    if (buffer.trim()) await frame(buffer);
    return events;
  } catch (error) { error.events = events; throw error; }
  finally { clearTimeout(timer); controller.abort(); controllers.delete(controller); output.end(); }
};
const answerText = events => events.filter(e => e.event === 'chunk').map(e => e.data.text ?? '').join('');
const assertDone = events => {
  const error = events.find(e => e.event === 'error');
  assert(!error, `Provider stream error: ${JSON.stringify(error?.data)}`);
  assert(events.some(e => e.event === 'done'), 'Terminal SSE done missing');
};
const send = async (chat, text, label, onEvent, controller) => {
  const turnId = `turn-${randomUUID()}`;
  chat.lastTurnId = turnId; save();
  if (chat.runtimeId === 'crew') {
    state.runtimeReadiness.crew.coverage = 'real-runtime-attempt';
    state.runtimeReadiness.crew.realSessionExercised = true;
    save();
  }
  const scopedText = `Acceptance scope: your only permitted filesystem directory is ${chat.cwd}. Read and write only files inside that exact directory. Never inspect or search home directories, repositories, application/configuration directories, credentials, provider settings, environment variables, process memory, databases, or stored prompts. Never cd outside this cwd, use parent paths, or search elsewhere to recover task content. Do not contact third parties or delegate. If the task cannot be completed using only the stated scratch files and conversation, say so and stop.\n\n${text}`;
  const events = await observeStream(`/chats/${chat.nodeId}/message`, { text: scopedText, nodeId: chat.nodeId, turnId, enableKiroSidecarTitle: false }, label, onEvent, controller);
  assertDone(events);
  return { turnId, events, text: answerText(events) };
};
const publicProfiles = arg('profiles') ? JSON.parse(fs.readFileSync(arg('profiles'), 'utf8')) : [];
assert(Array.isArray(publicProfiles), '--profiles must be an array of public runtime profiles');
for (const profile of publicProfiles) for (const key of Object.keys(profile)) assert(['version', 'runtimeId', 'providerId', 'modelId', 'reasoning', 'modeId'].includes(key), `Unexpected profile field: ${key}`);
const localConfig = safeConfig(configDir).agent ?? {};
let agentStatus;
const profileFor = runtimeId => publicProfiles.find(p => p.runtimeId === runtimeId) ?? {
  version: 1, runtimeId,
  ...(runtimeId === 'pi' ? { providerId: localConfig.providerByRuntime?.pi ?? localConfig.provider ?? 'anthropic' } : {}),
  ...(localConfig.modelByRuntime?.[runtimeId] ? { modelId: localConfig.modelByRuntime[runtimeId] } : {}),
  ...(localConfig.reasoningByRuntime?.[runtimeId] ? { reasoning: localConfig.reasoningByRuntime[runtimeId] } : {}),
};
const newChat = async (runtimeId, name, extra = {}) => {
  const nodeId = `n-${randomUUID()}`;
  const parent = extra.parent;
  const workspaceId = parent?.workspaceId ?? `${state.id}-${runtimeId}-${randomUUID().slice(0, 6)}`;
  const treeId = parent?.treeId ?? `tree-${randomUUID()}`;
  const cwd = parent?.cwd ?? path.join(runDir, 'files', runtimeId, name);
  fs.mkdirSync(cwd, { recursive: true });
  const now = Date.now();
  const graph = { workspace: { id: workspaceId, name: `${state.id} / ${runtimeId} / ${name}`, cwd, createdAt: now, activeTreeId: treeId },
    ...(!parent ? { tree: { id: treeId, rootNodeId: nodeId, name, lastActiveAt: now, createdAt: now } } : {}),
    node: { id: nodeId, treeId, parentNodeId: parent?.nodeId ?? null, kind: 'chat', title: name, createdAt: now },
    edges: parent ? [{ id: `edge-${randomUUID()}`, sourceNodeId: parent.nodeId, targetNodeId: nodeId, kind: 'branch', anchorMessageId: extra.anchorMessageId, createdAt: now }] : [],
  };
  await api('POST', `/workspaces/${workspaceId}/graph/nodes/ensure`, graph);
  // This generated ID ties the HTTP backend to the explicitly selected DB
  // before ensure-session is allowed to create a real provider session.
  assert.equal(db.prepare('SELECT workspace_id FROM nodes WHERE id = ?').get(nodeId)?.workspace_id, workspaceId, 'HTTP backend does not use the supplied isolated SQLite database');
  const chat = { nodeId, workspaceId, treeId, cwd, runtimeId, name, profile: profileFor(runtimeId) };
  state.chats.push(chat);
  if (!parent) state.workspaces.push({ id: workspaceId, cwd, runtimeId });
  save();
  if (!extra.graphOnly) await ensure(chat, extra.agentDefinitionId ? { agentDefinitionId: extra.agentDefinitionId } : {});
  return chat;
};
const ensure = async (chat, extra = {}) => {
  const result = await api('POST', `/nodes/${chat.nodeId}/ensure-session`, { workspaceId: chat.workspaceId, cwd: chat.cwd, ...chat.profile, version: undefined, permissionMode: chat.runtimeId === 'crew' ? 'ask' : 'trust', ...(chat.runtimeId === 'crew' ? { crewMemoryMode: 'temporary' } : {}), enableFollowUps: false, ...extra }, { timeoutMs });
  assert.equal(result.chatId, chat.nodeId, 'Public session must retain node id');
  assert.equal(result.runtimeId, chat.runtimeId);
  writeEvidence(`${chat.runtimeId}-${chat.name}.ensure.json`, result);
  return result;
};
const policy = { version: 1, preset: 'custom', categories: { read: 'allow', search: 'allow', artifact_write: 'allow', filesystem_write: 'allow', shell_exec: 'allow', external_action: 'deny', spawn_agent: 'deny' }, maxDelegationDepth: 1, maxConcurrentRuns: 4, maxWallTimeMs: 300_000, maxAttempts: 1 };
const contextPolicy = { version: 1, includeWorkspaceInstructions: false, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true, maxEstimatedChars: 30_000 };
const capabilityEntries = async workspaceId => {
  const catalog = await api('GET', `/agent-capabilities?workspaceId=${encodeURIComponent(workspaceId)}`);
  return catalog.capabilities.filter(c => c.kind === 'tool' && c.readiness === 'ready' && ['bash', 'read', 'write', 'edit', 'ls'].includes(c.id));
};
const definitionBody = (chat, instructions, entries) => ({ version: 1, scope: 'workspace', workspaceId: chat.workspaceId, name: `${state.id} ${chat.name}`, description: 'Disposable real acceptance definition', instructions, runtimeProfile: chat.profile, fallbackChain: [], toolRefs: entries.map(e => e.id), skillRefs: [], mcpServerRefs: [], permissionPolicy: policy, contextPolicy, defaultRunTtlMs: null });
const ephemeral = async chat => ({ version: 1, name: `${state.id} worker`, description: 'Disposable real runtime acceptance', instructions: 'Perform only the supplied acceptance task. All filesystem work must stay in the supplied cwd. Do not contact third parties, inspect credentials, or delegate.', runtimeProfile: chat.profile, fallbackChain: [], capabilitySnapshot: { version: 1, entries: (await capabilityEntries(chat.workspaceId)).map(({ id, kind, revision, schemaHash, contentHash, configHash, publicSchema, publicConfig, credentialBindingIds }) => ({ id, kind, revision, schemaHash, contentHash, configHash, publicSchema, publicConfig, credentialBindingIds })) }, permissionPolicy: policy, contextPolicy });
const spawnRun = async (chat, task) => {
  assert(chat.profile.modelId, `Agent Run needs explicit public modelId; supply --profiles for ${chat.runtimeId}`);
  const { run } = await api('POST', '/agent-runs', { version: 1, workspaceId: chat.workspaceId, agentId: null, ephemeralDefinition: await ephemeral(chat), task, contextManifest: { version: 1, entries: [], assembledAt: Date.now(), estimatedChars: 0 }, permissionRestriction: null, environment: { version: 1, kind: 'shared_workspace', access: 'read_write' }, expectedResult: null, completionMode: 'detach', invocationMode: 'manual', runTtlMs: null, parentRunId: null, parentAttemptId: null, parentNodeId: null, parentTurnId: null, parentMessageId: null, parentToolCallId: null }, { timeoutMs });
  state.runs.push(run.id); save(); return run;
};
const waitRun = runId => poll(`Agent Run ${runId} terminal`, async () => { const detail = await api('GET', `/agent-runs/${runId}`); return ['completed', 'failed', 'cancelled'].includes(detail.run.status) ? detail : null; });
const file = (chat, name) => path.join(chat.cwd, name);
const exists = (chat, name) => fs.existsSync(file(chat, name));
const read = (chat, name) => fs.readFileSync(file(chat, name), 'utf8');
const shell = (started, late, token, seconds) => `python3 -c "from pathlib import Path; import time; Path('${started}').write_text('${token}'); time.sleep(${seconds}); Path('${late}').write_text('${token}')"`;

const cleanup = async () => {
  const results = [];
  const attempt = async (kind, id, fn) => { try { await fn(); results.push({ kind, id, ok: true }); } catch (e) { results.push({ kind, id, ok: false, error: e.message }); } };
  // No process discovery, pkill, application shutdown, or workspace deletion.
  for (const id of state.jobs) {
    await attempt('job-cancel', id, () => api('POST', `/scheduled-jobs/${id}/cancel`, {}, { allowStatuses: [404] }));
    await attempt('job-delete', id, () => api('DELETE', `/scheduled-jobs/${id}`, undefined, { allowStatuses: [404] }));
  }
  for (const id of state.runs) await attempt('run-cancel', id, () => api('POST', `/agent-runs/${id}/cancel`, { version: 1, expectedAttemptId: null, reason: 'live acceptance harness cleanup' }, { allowStatuses: [404, 409] }));
  for (const chat of state.chats) if (chat.lastTurnId) await attempt('chat-cancel', chat.nodeId, () => api('POST', `/chats/${chat.nodeId}/cancel`, { turnId: chat.lastTurnId }, { allowStatuses: [404] }));
  for (const id of state.definitions) await attempt('definition-disable', id, () => api('POST', `/agents/${id}/disable`, {}, { allowStatuses: [404] }));
  writeEvidence('cleanup.json', results);
};
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  shuttingDown = true; for (const c of controllers) c.abort();
  state.interrupted = { signal, at: Date.now() };
  await cleanup(); save();
  writeEvidence('summary.json', { mode: 'real-production-http-sqlite-provider', manifestPath, runtimeReadiness: state.runtimeReadiness, interrupted: state.interrupted, results: state.results });
  db.close(); process.exit(130);
});

const cases = {
  async 'exact-reply'(runtimeId) {
    const chat = await newChat(runtimeId, 'exact-reply');
    const marker = `EXACT_${randomUUID().replaceAll('-', '')}`;
    const result = await send(chat, `Please reply with the single word ${marker}. No tools are needed for this request.`, `${runtimeId}-exact-reply`);
    const shared = await import('../../shared/dist/index.js');
    const finalizeTurnContent = shared.finalizeTurnContent ?? shared.default?.finalizeTurnContent;
    const visible = finalizeTurnContent(result.text);
    const persisted = await snapshot(chat, `${runtimeId}-exact-reply`);
    assert.equal(visible, marker, 'The selected real runtime must answer the exact requested word');
    assert(!result.events.some(event => ['tool_call', 'tool_call_update', 'permission_request'].includes(event.event)), 'This minimal case must not execute or approve tools');
    assert.equal(persisted.node.runtime_id, runtimeId, 'Persistence must retain the selected runtime identity');
    assert.equal(persisted.messages.filter(message => message.role === 'assistant').at(-1)?.content, marker);
    if (runtimeId === 'crew') {
      assert.equal(persisted.node.crew_memory_mode, 'temporary', 'Only this new chat must have learned Memory disabled');
      state.runtimeReadiness.crew.coverage = 'real-minimal-text';
      save();
    }
    return { nodeId: chat.nodeId, runtimeId, visibleProjection: visible, noTools: true, persisted: true, ...(runtimeId === 'crew' ? { existingSetupOnly: true, consentChanged: false, globalConfigurationChanged: false, memoryMode: 'temporary', permissionMode: 'ask', modelSelection: chat.profile.modelId ?? 'existing Gateway default' } : {}) };
  },
  async 'stream-io'(runtimeId) {
    const chat = await newChat(runtimeId, 'stream-io');
    const token = `STREAM_${randomUUID().slice(0, 8)}`;
    const content = `${token}\n${Array.from({ length: 6 }, (_, i) => `LINE_${String(i + 1).padStart(3, '0')}: abcdefghijklmnop`).join('\n')}\nEND_${token}\n`;
    fs.writeFileSync(file(chat, 'stream-source.txt'), content, { mode: 0o600 });
    const codexProgram = `from pathlib import Path; expected = ${JSON.stringify(content)}; source = Path("stream-source.txt").read_text(); assert source == expected; Path("streamed-input.txt").write_text(source); copied = Path("streamed-input.txt").read_text(); assert copied == expected; print(copied.splitlines()[0]); print(copied.splitlines()[-1])`;
    const instruction = runtimeId === 'codex'
      ? `Your native filesystem access may be through exec_command. Run exactly this single command with your working directory fixed to the allowed cwd; do not add any other commands, searches, files or paths: python3 -c '${codexProgram}'. It reads only stream-source.txt, checks its known content, writes only streamed-input.txt, and reads that copy. Reply only with the command's first and last output line.`
      : 'Use filesystem tools to read relative file stream-source.txt from this cwd, then write an exact copy with its final newline to relative file streamed-input.txt using the write/edit tool, then read streamed-input.txt with a filesystem read tool. This task has exactly two scratch files and needs no search. Do not use bash/shell or inspect any other file. Reply with only the first and last line of the copied file.';
    const result = await send(chat, instruction, `${runtimeId}-stream-io`);
    assert.equal(read(chat, 'streamed-input.txt'), content, 'Real filesystem content must match long tool input');
    const tools = result.events.filter(e => ['tool_call', 'tool_call_update'].includes(e.event));
    assert(tools.some(e => typeof e.data.inputJson === 'string' && e.data.inputJson.includes(token)), 'Stream must carry actual tool input, not title only');
    const persisted = await snapshot(chat, `${runtimeId}-stream-io`);
    assert(persisted.messages.some(m => m.role === 'assistant' && String(m.tool_calls).includes(token)), 'Hydrated SQLite tool input must preserve marker');
    assert(result.text.includes(token));
    return { nodeId: chat.nodeId, toolEvents: tools.length, inputEvents: tools.filter(e => e.data.inputJson).length, bytes: Buffer.byteLength(content) };
  },
  async recovery(runtimeId) {
    const chat = await newChat(runtimeId, 'recovery');
    const token = `MEMORY_${randomUUID().slice(0, 8)}`;
    const first = await send(chat, `Remember the verification word ${token}. Reply ACK_${token} only.`, `${runtimeId}-recovery-seed`);
    assert(first.text.includes(token));
    const before = await snapshot(chat, `${runtimeId}-recovery-before`);
    const controller = new AbortController();
    let disconnected = false;
    try {
      await send(chat, `Use a shell tool to run ${shell('reconnect-start.txt', 'reconnect-finish.txt', token, 5)}. Then reply REPLAY_${token}.`, `${runtimeId}-disconnect`, async event => {
        if (!disconnected && ['tool_call', 'tool_call_update'].includes(event.event)) { disconnected = true; controller.abort(); }
      }, controller);
    } catch (e) { if (!disconnected) throw e; }
    assert(disconnected, 'Subscriber disconnect must occur while a tool turn is active');
    const turnId = chat.lastTurnId;
    const replay = await observeStream(`/chats/${chat.nodeId}/stream?fromTurnId=${encodeURIComponent(turnId)}&fromSeq=0`, undefined, `${runtimeId}-reconnect-replay`);
    assertDone(replay);
    assert(answerText(replay).includes(`REPLAY_${token}`));
    assert(exists(chat, 'reconnect-finish.txt'), 'Renderer disconnect must not cancel durable turn');
    await ensure(chat);
    const second = await send(chat, 'What verification word did I ask you to remember? Reply only that word.', `${runtimeId}-recovery-followup`);
    assert(second.text.includes(token), 'Multi-turn memory must survive ensure/reconnect');
    const after = await snapshot(chat, `${runtimeId}-recovery-after`);
    assert(before.messages.every(m => after.messages.some(n => n.id === m.id)), 'Hydration must preserve message IDs');
    const seq = replay.filter(e => e.data.turnId === turnId && Number.isInteger(e.data.seq)).map(e => e.data.seq);
    assert(seq.length > 0 && seq.every((n, i) => i === 0 || n > seq[i - 1]), 'Replay sequence watermark must increase');
    return { nodeId: chat.nodeId, turnId, replayEvents: replay.length, note: 'Real HTTP disconnect, replay, ensure-session and SQLite hydration; process restart is a separate two-phase case.' };
  },
  async cancel(runtimeId) {
    const chat = await newChat(runtimeId, 'cancel');
    const token = `CANCEL_${randomUUID().slice(0, 8)}`;
    const started = Date.now();
    const stream = send(chat, `Use a shell tool to run exactly this command in cwd, wait for it, and then say COMPLETED: ${shell('cancel-start.txt', 'cancel-late.txt', token, 25)}`, `${runtimeId}-cancel`).catch(e => ({ streamError: e.message, events: e.events ?? [] }));
    await poll('delayed shell actually started', () => exists(chat, 'cancel-start.txt'), Math.min(timeoutMs, 90_000));
    assert.equal(read(chat, 'cancel-start.txt'), token);
    const cancellation = await api('POST', `/chats/${chat.nodeId}/cancel`, { turnId: chat.lastTurnId }, { timeoutMs });
    const settled = await stream;
    // Wait past the shell deadline, regardless of stream response speed.
    const deadline = Date.now() + 28_000;
    while (Date.now() < deadline) { assert(!exists(chat, 'cancel-late.txt'), 'Cancelled shell produced a delayed side effect'); await delay(500); }
    const next = await send(chat, 'Reply exactly RECOVERED. Do not call any tool.', `${runtimeId}-cancel-followup`);
    assert(next.text.includes('RECOVERED'));
    const persisted = await snapshot(chat, `${runtimeId}-cancel`);
    return { nodeId: chat.nodeId, cancellation, elapsedMs: Date.now() - started, delayedWriteAbsent: true, cancelledTurn: persisted.turns.at(-2), events: settled.events?.length ?? 0 };
  },
  async fork(runtimeId) {
    const parent = await newChat(runtimeId, 'fork-parent');
    const early = `EARLY_${randomUUID().slice(0, 8)}`;
    const late = `LATE_${randomUUID().slice(0, 8)}`;
    await send(parent, `The verification word is ${early}. Reply ACK_${early}.`, `${runtimeId}-fork-early`);
    const anchor = queryNode(parent.nodeId).messages.filter(m => m.role === 'assistant').at(-1);
    assert(anchor?.id);
    await send(parent, `Replace the verification word with ${late}. Reply ACK_${late}.`, `${runtimeId}-fork-late`);
    const child = await newChat(runtimeId, 'fork-child', { parent, anchorMessageId: anchor.id });
    const answer = await send(child, 'What is the verification word? Reply only that word; do not read files or other chats.', `${runtimeId}-fork-child`);
    assert(answer.text.includes(early), 'Child must inherit the selected historical prefix');
    assert(!answer.text.includes(late), 'Child must not inherit parent tail after anchor');
    const edge = db.prepare('SELECT * FROM edges WHERE target_node_id = ? AND source_node_id = ?').get(child.nodeId, parent.nodeId);
    assert.equal(edge.fork_boundary_message_id, anchor.id);
    await snapshot(child, `${runtimeId}-fork`);
    return { parentNodeId: parent.nodeId, childNodeId: child.nodeId, anchorId: anchor.id, forkKind: edge.fork_kind };
  },
  async 'user-input'(runtimeId) {
    if (runtimeId === 'pi') return { status: 'skipped', reason: 'Current Pi ordinary-chat tool catalog has no structured ask_user implementation. Text questions cannot prove durable cards.' };
    const chat = await newChat(runtimeId, 'user-input');
    const requests = [];
    const result = await send(chat, 'Acceptance task: ask me exactly two separate sequential structured questions using AskUserQuestion, request_user_input, or the Michi ask_user tool. First ask "First verification choice?" with Alpha/Beta. After receiving my answer, ask "Second verification choice?" with Gamma/Delta. Do not combine the questions. After both answers reply INPUT_COMPLETE and repeat both answers. Never answer the questions yourself.', `${runtimeId}-user-input`, async event => {
      if (event.event !== 'user_input_request') return;
      requests.push(event.data);
      assert(requests.length <= 2, 'Unexpected additional structured input');
      await poll('pending structured input persisted', () => queryNode(chat.nodeId).messages.some(m => {
        try { return JSON.parse(m.blocks ?? '[]').some(b => b.kind === 'user-input' && b.interaction?.status === 'pending'); }
        catch { return false; }
      }), 10_000);
      const pending = await snapshot(chat, `${runtimeId}-user-input-pending-${requests.length}`);
      const blocks = pending.messages.flatMap(m => { try { return JSON.parse(m.blocks ?? '[]'); } catch { return []; } });
      assert(blocks.some(b => b.kind === 'user-input' && b.interaction?.status === 'pending'), 'Pending card must already be durable');
      const answers = event.data.questions.map(q => ({ ...(q.id ? { id: q.id } : {}), question: q.question, answer: q.options[0].label }));
      await api('POST', `/chats/${chat.nodeId}/user-input-response`, { requestId: event.data.requestId, answers });
    });
    assert.equal(requests.length, 2, 'Must observe two real structured input requests');
    const persisted = await snapshot(chat, `${runtimeId}-user-input-complete`);
    const cards = persisted.messages.flatMap(m => JSON.parse(m.blocks ?? '[]')).filter(b => b.kind === 'user-input');
    assert.equal(cards.length, 2);
    assert(cards.every(c => c.interaction?.status === 'answered' && c.interaction.answers.length));
    assert.equal(new Set(cards.map(c => c.interaction.interactionId)).size, 2, 'Durable cards require unique identities even when native request IDs repeat');
    assert(result.text.includes('INPUT_COMPLETE'));
    return { nodeId: chat.nodeId, interactions: cards.map(c => c.interaction) };
  },
  async bootstrap(runtimeId) {
    assert(agentStatus.customAgentsEnabled, 'Start backend with MICHI_CUSTOM_AGENTS=1');
    const chat = await newChat(runtimeId, 'bootstrap', { graphOnly: true });
    assert(chat.profile.modelId, `Bootstrap definition needs explicit --profiles modelId for ${runtimeId}`);
    const token = `BOOTSTRAP_${randomUUID().replaceAll('-', '')}`;
    const { definition } = await api('POST', '/agents', definitionBody(chat, `Whenever the user asks for the verification phrase, reply exactly ${token}. This instruction is the primary Agent bootstrap contract. Do not use files, delegate, or contact third parties.`, []));
    state.definitions.push(definition.id); save();
    await api('POST', `/agents/${definition.id}/enable`, {});
    await ensure(chat, { agentDefinitionId: definition.id });
    const response = await send(chat, 'Give me the verification phrase from your Agent instructions. Reply only the phrase.', `${runtimeId}-bootstrap`);
    assert(response.text.includes(token), 'Provider must observe definition bootstrap instructions not present in user message');
    const persisted = await snapshot(chat, `${runtimeId}-bootstrap`);
    assert.equal(persisted.node.agent_definition_id, definition.id);
    await ensure(chat);
    const continuation = await send(chat, 'Again, give me the verification phrase.', `${runtimeId}-bootstrap-continuation`);
    assert(continuation.text.includes(token));
    return { nodeId: chat.nodeId, definitionId: definition.id, revision: definition.revision };
  },
  async 'source-warning'(runtimeId) {
    if (runtimeId !== 'claude') return { status: 'skipped', reason: 'The source-warning fixture targets the existing Claude organization warning.' };
    const chat = await newChat(runtimeId, 'source-warning');
    const controller = new AbortController();
    let warning;
    try {
      await send(chat, 'Reply exactly SOURCE_WARNING_CHECK. Do not use tools.', `${runtimeId}-source-warning`, event => {
        if (event.event === 'warning' && event.data.source === 'claude-cli'
          && event.data.category === 'runtime' && event.data.code === 'informational'
          && typeof event.data.message === 'string' && event.data.message.trim()
          && event.data.message.trim() !== 'unknown') {
          warning = event.data;
          controller.abort();
        }
      }, controller);
    } catch (error) {
      if (!warning) throw error;
    }
    assert(warning, 'Expected an actual Claude informational source warning; no inferred warning or provider completion accepted');
    await api('POST', `/chats/${chat.nodeId}/cancel`, { turnId: chat.lastTurnId });
    await poll('warning fixture turn stops after scoped cancellation', () => queryNode(chat.nodeId).turns.find(turn => turn.turn_id === chat.lastTurnId && ['completed', 'cancelled', 'failed', 'error'].includes(turn.status)));
    const persisted = await snapshot(chat, `${runtimeId}-source-warning`);
    const warnings = persisted.messages.filter(message => message.role === 'assistant').flatMap(message => {
      try { return JSON.parse(message.metadata ?? '{}').warnings ?? []; } catch { return []; }
    });
    assert(warnings.some(item => item.source === warning.source && item.code === warning.code && item.message === warning.message), 'The actual source warning must survive durable hydration');
    return { nodeId: chat.nodeId, warning, persistedWarning: true, providerCompletionEstablished: false, note: 'Intentionally cancelled after observing and persisting the real runtime warning; this does not establish a completed model response.' };
  },
  async metadata(runtimeId) {
    if (!['claude', 'codex'].includes(runtimeId)) return { status: 'skipped', reason: 'Metadata completion audit targets Claude/Codex; other runtime behavior is covered by ordinary cases.' };
    const chat = await newChat(runtimeId, 'metadata');
    const marker = `METADATA_${randomUUID().replaceAll('-', '')}`;
    const result = await send(chat, `Please reply with the single word ${marker}. No tools are needed for this request.`, `${runtimeId}-metadata`);
    const shared = await import('../../shared/dist/index.js');
    const finalizeTurnContent = shared.finalizeTurnContent ?? shared.default?.finalizeTurnContent;
    assert.equal(typeof finalizeTurnContent, 'function', 'Build shared code before metadata acceptance');
    const visible = finalizeTurnContent(result.text);
    const persisted = await snapshot(chat, `${runtimeId}-metadata`);
    assert.equal(visible, marker, 'Production visible projection must remain a single exact reply without repair/acknowledgement leakage');
    assert(result.events.some(e => e.event === 'branch_overview' && e.data.overview?.trim()), 'Overview must remain available while follow-ups are disabled');
    assert(!result.events.some(e => ['follow_ups', 'follow_ups_status'].includes(e.event)), 'Disabled follow-ups must not emit list or status');
    assert.equal(persisted.messages.filter(m => m.role === 'assistant').at(-1)?.content, marker, 'Durable assistant visible content must match production projection');
    return { nodeId: chat.nodeId, overviewEvents: result.events.filter(e => e.event === 'branch_overview').length, followUpsDisabled: true, visibleProjection: visible, rawTransportMayContainSentinels: true };
  },
  async 'run-queued'(runtimeId) { return runSteering(runtimeId, 'queued'); },
  async 'run-immediate'(runtimeId) { return runSteering(runtimeId, 'immediate'); },
  async 'scheduled-isolation'(runtimeId) {
    const chat = await newChat(runtimeId, 'scheduled-isolation');
    const jobs = [];
    for (const name of ['A', 'B']) {
      const token = `JOB_${name}_${randomUUID().slice(0, 8)}`;
      const job = await api('POST', '/scheduled-jobs', { workspaceId: chat.workspaceId, name: `${state.id}-${name}`, prompt: `Run this shell in cwd: ${shell(`job-${name}-start.txt`, `job-${name}-finish.txt`, token, 8)}. Then reply ${token} only. Never read other files or chats.`, schedule: { kind: 'at', at: Date.now() + 2_000 }, ...chat.profile, permissionMode: 'trust', sessionMode: 'fresh', notify: false, enabled: name === 'A', timeoutSeconds: 120 });
      state.jobs.push(job.id); jobs.push({ job, token, name }); save();
    }
    const foreground = send(chat, 'Remember only FOREGROUND_ISOLATED. Reply FOREGROUND_ISOLATED only.', `${runtimeId}-scheduled-foreground`);
    const first = await poll('automatic scheduled job started', async () => { const { runs } = await api('GET', `/scheduled-jobs/${jobs[0].job.id}/runs`); return runs.find(r => r.trigger === 'scheduled'); });
    const second = await api('POST', `/scheduled-jobs/${jobs[1].job.id}/run`, {}, { withStatus: true, allowStatuses: [409] });
    let manual = second.data;
    if (second.status === 409) {
      await poll('automatic job releases global admission', async () => { const r = await api('GET', `/scheduled-jobs/runs/${first.id}`); return r.status !== 'running' ? r : null; });
      manual = await api('POST', `/scheduled-jobs/${jobs[1].job.id}/run`, {});
    }
    const completed = [];
    for (const run of [first, manual]) completed.push(await poll('scheduled run completed', async () => { const r = await api('GET', `/scheduled-jobs/runs/${run.id}`); return r.status !== 'running' ? r : null; }));
    assert(completed.every(r => r.status === 'succeeded'), JSON.stringify(completed));
    assert.notEqual(completed[0].nodeId, completed[1].nodeId);
    assert(completed.every(r => r.nodeId && r.nodeId !== chat.nodeId));
    state.workspaces.find(w => w.id === chat.workspaceId).scheduledNodeIds = completed.map(r => r.nodeId); save();
    for (let i = 0; i < completed.length; i++) {
      const record = queryNode(completed[i].nodeId);
      const answer = record.messages.filter(m => m.role === 'assistant').map(m => m.content).join('\n');
      assert(answer.includes(jobs[i].token));
      assert(!answer.includes(jobs[1 - i].token), 'Scheduled results crossed session ownership');
      assert.equal(read(chat, `job-${jobs[i].name}-finish.txt`), jobs[i].token);
      writeEvidence(`${runtimeId}-scheduled-${jobs[i].name}.sqlite.json`, record);
    }
    assert((await foreground).text.includes('FOREGROUND_ISOLATED'));
    const hydrated = await snapshot(chat, `${runtimeId}-scheduled-foreground`);
    assert(!hydrated.messages.some(m => m.content.includes(jobs[0].token) || m.content.includes(jobs[1].token)), 'Background scheduled results must not overwrite foreground messages');
    const overlap = Math.max(completed[0].startedAt, completed[1].startedAt) < Math.min(completed[0].finishedAt, completed[1].finishedAt);
    return { nodeId: chat.nodeId, runs: completed, concurrentOverlapObserved: overlap, manualAdmissionStatus: second.status, note: overlap ? 'Actual scheduled and manual executions overlapped with independent nodes.' : 'Global capacity serialized scheduled/manual admission; session isolation verified.' };
  },
  async 'restart-seed'(runtimeId) {
    const chat = await newChat(runtimeId, 'restart');
    const token = `RESTART_${randomUUID().slice(0, 8)}`;
    await send(chat, `Remember the verification word ${token}. Reply ACK_${token}.`, `${runtimeId}-restart-seed`);
    const persisted = await snapshot(chat, `${runtimeId}-restart-seed`);
    state.restartSeeds.push({ chat, token, messageIds: persisted.messages.map(m => m.id), verified: false }); save();
    return { nodeId: chat.nodeId, manifestPath, action: 'Root must now stop/restart only its isolated backend, then use restart-verify with this manifest.' };
  },
  async 'restart-verify'(runtimeId) {
    const seed = state.restartSeeds.find(s => s.chat.runtimeId === runtimeId && !s.verified);
    assert(seed, `No unverified restart seed for ${runtimeId}`);
    await ensure(seed.chat);
    const result = await send(seed.chat, 'What verification word did I ask you to remember? Reply only the word.', `${runtimeId}-restart-verify`);
    assert(result.text.includes(seed.token), 'Provider history must survive actual backend process restart');
    const persisted = await snapshot(seed.chat, `${runtimeId}-restart-verify`);
    assert(seed.messageIds.every(id => persisted.messages.some(m => m.id === id)));
    seed.verified = true; save();
    return { nodeId: seed.chat.nodeId, preservedMessageIds: seed.messageIds, note: 'Harness depends on root proving the backend PID changed between phases.' };
  },
};
async function runSteering(runtimeId, mode) {
  assert(agentStatus.customAgentsEnabled, 'Start backend with MICHI_CUSTOM_AGENTS=1');
  const chat = await newChat(runtimeId, `run-${mode}`, { graphOnly: true });
  const token = `STEER_${mode.toUpperCase()}_${randomUUID().slice(0, 8)}`;
  const initialLate = `run-${mode}-initial.txt`;
  const run = await spawnRun(chat, `Use a shell tool to run exactly ${shell(`run-${mode}-start.txt`, initialLate, token, mode === 'immediate' ? 25 : 7)}. Then briefly report the initial step done. Perform only the supplied task and accept follow-up user input.`);
  await poll(`real ${mode} Agent Run shell started`, async () => {
    if (exists(chat, `run-${mode}-start.txt`)) return true;
    const early = await api('GET', `/agent-runs/${run.id}`);
    if (['completed', 'failed', 'cancelled'].includes(early.run.status)) {
      writeEvidence(`${runtimeId}-run-${mode}.early.json`, early);
      throw new Error(`Agent Run ended ${early.run.status} before its required shell start; inspect ${runtimeId}-run-${mode}.early.json`);
    }
    return false;
  }, Math.min(timeoutMs, 90_000));
  const detail = await api('GET', `/agent-runs/${run.id}`);
  assert(detail.run.activeAttemptId);
  await api('POST', `/agent-runs/${run.id}/input`, { version: 1, text: `New acceptance instruction: write exactly ${token} to relative file run-${mode}-steered.txt in cwd using a tool, and finish with ${token}.`, mode, expectedAttemptId: detail.run.activeAttemptId }, { timeoutMs });
  const done = await waitRun(run.id);
  writeEvidence(`${runtimeId}-run-${mode}.json`, done);
  const durableAttempts = db.prepare('SELECT id, public_session_id, status FROM agent_run_attempts WHERE run_id = ? ORDER BY attempt_index').all(run.id);
  writeEvidence(`${runtimeId}-run-${mode}.attempts.sqlite.json`, durableAttempts);
  assert.equal(done.run.status, 'completed', JSON.stringify(done.run.resultBundle));
  assert.equal(read(chat, `run-${mode}-steered.txt`), token, 'Accepted steering must reach real provider and cause a distinct receipt');
  assert(done.events.some(e => e.type === 'steering_queued' && e.payload.mode === mode));
  assert(done.events.some(e => e.type === 'steering_applied' && e.payload.mode === mode));
  assert.equal(new Set(done.attempts.map(a => a.publicSessionId)).size, done.attempts.length);
  assert(done.attempts.every(a => a.publicSessionId === a.id && a.publicSessionId !== chat.nodeId));
  assert.equal(durableAttempts.length, done.attempts.length, 'HTTP and durable attempt counts must agree');
  assert(durableAttempts.every(a => a.public_session_id === a.id && a.public_session_id !== chat.nodeId), 'Newly created durable attempts must use their actual attempt ID as public session ID');
  if (mode === 'immediate') {
    const end = Date.now() + 28_000;
    while (Date.now() < end) { assert(!exists(chat, initialLate), 'Immediate steering left a cancelled delayed side effect'); await delay(500); }
  } else assert.equal(read(chat, initialLate), token, 'Queued steering must preserve first step');
  return { runId: run.id, attemptIds: done.attempts.map(a => a.id), status: done.run.status, steeringMode: mode };
}

let fatal;
try {
  save();
  if (!flag('cleanup-only')) {
    const health = await api('GET', '/health');
    assert.equal(health.service, 'michi-backend');
    agentStatus = await api('GET', '/agent/status');
    const crewStatus = await api('GET', '/crew/status');
    state.runtimeReadiness = { availableRuntimes: agentStatus.availableRuntimes, crew: { integration: crewStatus, coverage: 'offline-integration-status-only', realSessionExercised: false, consentChanged: false } };
    writeEvidence('backend-preflight.json', { health, ...state.runtimeReadiness, customAgentsEnabled: agentStatus.customAgentsEnabled, config: safeConfig(configDir) });
    const runtimes = arg('runtimes', 'claude,codex,kiro,pi').split(',');
    assert(runtimes.every(r => ['claude', 'codex', 'kiro', 'pi', 'crew'].includes(r)), 'Unknown runtime');
    const selected = arg('cases', CASES.join(',')).split(',');
    assert(selected.every(c => cases[c]), `Unknown case; choices: ${Object.keys(cases)}`);
    if (runtimes.includes('crew')) {
      const integration = state.runtimeReadiness.crew.integration;
      const decision = { explicitExistingSetupAuthorization: flag('allow-existing-crew'), integration, allowedCasesOnly: selected.every(name => name === 'exact-reply'), available: agentStatus.availableRuntimes?.some(runtime => runtime.id === 'crew' && runtime.available), consentChanged: false, accountCreated: false, configurationChanged: false };
      writeEvidence('crew-existing-setup-decision.json', decision);
      assert(decision.explicitExistingSetupAuthorization, 'Crew requires explicit --allow-existing-crew authorization for the existing setup');
      assert(decision.allowedCasesOnly, 'Crew is limited to exact-reply; no implicit tool/approval/steering coverage');
      assert(decision.available && integration.enabled && integration.approvals && integration.mcpDeclared && integration.mcpRouted && !integration.updateRequired, 'Crew setup gate is incomplete; do not create a session or bypass it');
    }
    const target = arg('target-runtime', runtimes[0]);
    for (const runtimeId of runtimes) for (const name of selected) {
      if (shuttingDown) break;
      const startedAt = Date.now();
      let result;
      if (!agentStatus.availableRuntimes?.some(r => r.id === runtimeId && r.available)) result = { status: 'skipped', reason: 'Runtime unavailable according to real backend status.' };
      else if (['run-queued', 'run-immediate', 'scheduled-isolation'].includes(name) && runtimeId !== target) result = { status: 'skipped', reason: `Target-only case; target runtime is ${target}.` };
      else {
        console.log(`[RUN] ${runtimeId}/${name}`);
        try { result = { status: 'passed', evidence: await cases[name](runtimeId) }; if (result.evidence?.status === 'skipped') result = result.evidence; }
        catch (e) { result = { status: 'failed', error: e.message }; await cleanup(); }
      }
      state.results.push({ runtimeId, case: name, startedAt, finishedAt: Date.now(), ...result }); save();
      console.log(`[${result.status.toUpperCase()}] ${runtimeId}/${name}${result.error ? `: ${result.error}` : ''}`);
    }
  }
} catch (e) { fatal = e; state.fatalError = e.message; }
finally { await cleanup(); save(); db.close(); }
const invocationResults = state.results.slice(initialResultCount);
writeEvidence('summary.json', { mode: 'real-production-http-sqlite-provider', manifestPath, runtimeReadiness: state.runtimeReadiness, results: state.results, invocationResults, priorResultsRetained: initialResultCount, fatalError: fatal?.message ?? null, counts: Object.fromEntries(['passed', 'failed', 'skipped'].map(status => [status, state.results.filter(r => r.status === status).length])), invocationCounts: Object.fromEntries(['passed', 'failed', 'skipped'].map(status => [status, invocationResults.filter(r => r.status === status).length])) });
console.log(`Evidence: ${runDir}`);
if (fatal) console.error(fatal.message);
process.exitCode = fatal || invocationResults.some(r => r.status === 'failed') ? 1 : 0;
