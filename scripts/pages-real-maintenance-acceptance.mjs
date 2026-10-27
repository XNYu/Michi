#!/usr/bin/env node

/** Real disposable acceptance for scheduled Pages maintenance. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const runtimeId = process.argv.includes('--runtime') ? process.argv[process.argv.indexOf('--runtime') + 1] : 'pi';
if (!['pi', 'claude'].includes(runtimeId)) throw new Error('Unattended maintenance acceptance supports only --runtime pi|claude.');
if (!process.argv.includes('--execute')) {
  console.log('Preflight only. Add --execute to start a disposable backend and invoke the real maintenance runtime.');
  process.exit(0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'michi-pages-maintenance-'));
const workspaceCwd = path.join(temp, 'workspace');
const dataDir = path.join(temp, 'data');
const configDir = path.join(temp, 'config');
const logDir = path.join(temp, 'logs');
const useBundle = process.env.MICHI_PAGES_ACCEPTANCE_USE_BUNDLE === '1';
await mkdir(workspaceCwd);
const port = await reservePort();
const childArgs = useBundle ? ['dist/server.js'] : ['--require', 'ts-node/register', 'src/server.ts'];
const child = spawn(process.execPath, childArgs, {
  cwd: path.join(root, 'backend'),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', MICHI_DATA_DIR: dataDir, MICHI_CONFIG_DIR: configDir, MICHI_LOG_DIR: logDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
let stdout = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000); });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
const api = `http://127.0.0.1:${port}/api`;
const evidence = { result: 'incomplete', runtimeId, backendSource: useBundle ? 'backend/dist/server.js' : 'backend/src/server.ts via ts-node',
  isolation: 'fresh disposable SQLite/config/log/workspace directories', checks: {}, events: [] };
const evidenceDir = path.join(root, 'docs/superpowers/plans/pages-real-runtime-evidence');
await mkdir(evidenceDir, { recursive: true });
const evidencePath = path.join(evidenceDir, `maintenance-${runtimeId}-${new Date().toISOString().replaceAll(':', '-')}.json`);
let activeTurn = false;
let interruptedSignal = null;
let cleanupPromise = null;
const onSignal = (signal) => {
  if (interruptedSignal) return;
  interruptedSignal = signal;
  evidence.result = 'interrupted';
  evidence.interruption = { signal, at: new Date().toISOString(), activeTurn,
    reason: process.env.MICHI_PAGES_ACCEPTANCE_ABORT_REASON || null };
  cleanupPromise = finalize();
};
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
  if (!await waitReady(api, child)) throw new Error(`Backend readiness failed: ${sanitize(`${stderr}\n${stdout}`).slice(0, 2500)}`);
  const auth = await get(`${api}/auth-config`);
  if (auth.requireAuth) throw new Error('Disposable backend unexpectedly requires authentication.');
  await post(`${api}/agent/options`, { runtime: runtimeId });
  const status = await get(`${api}/agent/status`);
  const runtimeStatus = (status.availableRuntimes ?? []).find((item) => item.id === runtimeId);
  if (!runtimeStatus?.available || status.hasRequiredKey !== true) throw new Error(`Runtime unavailable or provider key not configured: ${runtimeId}`);
  if (runtimeId === 'pi' && status.provider !== 'deepseek') throw new Error(`Pi selected unexpected provider ${status.provider ?? '(none)'}`);
  if (runtimeId === 'pi' && status.model !== 'deepseek-v4-pro') throw new Error(`Pi selected unexpected model ${status.model ?? '(none)'}`);
  evidence.runtime = { id: runtimeId, provider: status.provider ?? null, model: status.model ?? null, hasRequiredKey: status.hasRequiredKey === true };

  const workspaceId = `pages-maintenance-${randomUUID()}`;
  const treeId = `tree-${randomUUID()}`;
  const nodeId = `node-${randomUUID()}`;
  await post(`${api}/workspaces/${encodeURIComponent(workspaceId)}/graph/nodes/ensure`, {
    workspace: { id: workspaceId, name: 'Disposable maintenance acceptance', cwd: workspaceCwd, createdAt: Date.now(), activeTreeId: treeId },
    tree: { id: treeId, rootNodeId: nodeId, name: 'Acceptance', createdAt: Date.now(), lastActiveAt: Date.now() },
    node: { id: nodeId, treeId, kind: 'chat', title: 'Ordinary release conclusion', createdAt: Date.now() }, edges: [],
  });
  evidence.ids = { workspaceId, treeId, nodeId };
  evidence.panes = { pagePanesOpen: false, helperOpen: false,
    method: 'isolated HTTP acceptance creates no renderer panes or helper sessions' };
  const pageA = await post(`${api}/workspaces/${encodeURIComponent(workspaceId)}/pages`, { title: 'Release Alpha', template: 'release' });
  const pageB = await post(`${api}/workspaces/${encodeURIComponent(workspaceId)}/pages`, { title: 'Release Beta', template: 'release' });
  const unrelated = await post(`${api}/workspaces/${encodeURIComponent(workspaceId)}/pages`, { title: 'Unrelated research', template: 'research' });
  const dbs = await get(`${api}/workspaces/${encodeURIComponent(workspaceId)}/databases`);
  const database = (dbs.items ?? []).find((item) => item.title === 'Release checklist' && (item.rows?.length ?? 0) > 0);
  if (!database) throw new Error('Release template did not provide a seeded shared-row database.');
  const dbRef = pageB.blocks.find((block) => block.type === 'database-ref');
  const pageBRisk = riskBlock(pageB.blocks);
  await post(`${api}/pages/${encodeURIComponent(pageB.id)}/edits`, {
    revision: pageB.revision,
    ops: [
      { op: 'update', id: dbRef.id, expectRev: dbRef.rev, block: { type: 'database-ref', databaseId: database.id, viewId: database.views[0]?.id } },
      { op: 'update', id: pageBRisk.id, expectRev: pageBRisk.rev, block: { type: 'markdown', text: 'Human reviewed: preserve staged rollback evidence.' } },
    ],
  });
  const pageARisk = riskBlock(pageA.blocks);
  await post(`${api}/pages/${encodeURIComponent(pageA.id)}/edits`, {
    revision: pageA.revision,
    ops: [{ op: 'update', id: pageARisk.id, expectRev: pageARisk.rev, block: { type: 'markdown', text: 'Human reviewed: preserve staged rollback evidence.' } }],
  });
  const seedRow = database.rows[0];
  const taskColumn = database.columns.find((column) => column.name === 'Task');
  const statusColumn = database.columns.find((column) => column.name === 'Status');
  const ownerColumn = database.columns.find((column) => column.name === 'Owner');
  if (!seedRow || !taskColumn || !statusColumn || !ownerColumn) throw new Error('Release checklist seed row or required columns are missing.');
  const dbSeeded = await post(`${api}/databases/${encodeURIComponent(database.id)}/edits`, {
    revision: database.revision,
    ops: [
      { op: 'row.update', id: seedRow.id, expectRev: seedRow.rev, values: { [taskColumn.id]: 'Validate staged rollback' } },
      { op: 'view.save', view: { name: 'Acceptance table', type: 'table', config: { filters: [], match: 'all', sorts: [] } } },
    ],
  });
  const before = { pageA: await get(`${api}/pages/${pageA.id}`), pageB: await get(`${api}/pages/${pageB.id}`), unrelated: await get(`${api}/pages/${unrelated.id}`), database: await get(`${api}/databases/${database.id}`) };
  evidence.ids.pageA = pageA.id; evidence.ids.pageB = pageB.id; evidence.ids.unrelatedPage = unrelated.id; evidence.ids.databaseId = database.id;
  evidence.seed = { rowId: seedRow.id, taskColumnId: taskColumn.id, statusColumnId: statusColumn.id, ownerColumnId: ownerColumn.id,
    riskA: pageARisk.id, riskB: pageBRisk.id, unrelatedBlockIds: unrelated.blocks.map((block) => block.id) };

  // Enable before the source conversation so the durable cursor includes it.
  const initialConfig = await get(`${api}/workspaces/${encodeURIComponent(workspaceId)}/maintenance`);
  const configResponse = await patch(`${api}/workspaces/${encodeURIComponent(workspaceId)}/maintenance`, {
    ...(initialConfig.config ? { expectedRevision: initialConfig.config.revision } : {}), enabled: true, paused: false,
    runtimeId, providerId: status.provider, modelId: status.model,
  });
  evidence.maintenanceConfig = { enabled: configResponse.config?.enabled, paused: configResponse.config?.paused,
    revision: configResponse.config?.revision, runtimeId: configResponse.config?.runtimeId,
    providerId: configResponse.config?.providerId, modelId: configResponse.config?.modelId, jobId: configResponse.config?.jobId };

  const session = await post(`${api}/nodes/${encodeURIComponent(nodeId)}/ensure-session`, {
    nodeId, workspaceId, cwd: workspaceCwd, runtimeId, providerId: status.provider, modelId: status.model, permissionMode: 'ask',
  });
  evidence.ordinarySession = { runtimeId: session.runtimeId, providerId: session.providerId ?? null, modelId: session.modelId ?? null };
  const chatId = session.chatId ?? nodeId;
  const turn = await sendTurn(chatId, [
    'For this reply, answer in plain text without tools.',
    'The verified conclusion for Release Alpha and Release Beta is that Release 8.4 passed the staged rollback rehearsal on 2026-10-22, so progress is complete. The existing “Validate staged rollback” checklist item is in progress and owned by Release Engineering. The remaining release risk is that the rollback report still needs a second-person review. This discussion is confined to the release; separate research remains unchanged.',
    'Reply with the conclusion in plain text only.',
  ].join('\n'));
  evidence.events.push({ kind: 'ordinary_conversation', ...turn.summary });
  if (turn.attention) throw new Error('Ordinary source turn requested attention; unattended test stopped.');
  evidence.checks.ordinaryTurnUsedNoPageTools = turn.summary.toolCalls.length === 0;
  evidence.ordinarySourceConclusion = turn.summary;

  const runResponse = await post(`${api}/workspaces/${encodeURIComponent(workspaceId)}/maintenance/run`, {});
  const runId = runResponse.run?.runId ?? runResponse.run?.id;
  evidence.run = { accepted: Boolean(runResponse.run), runId: runId ?? null };
  const finalView = await pollMaintenance(workspaceId, runId, evidence);
  const durable = await readDurableMaintenanceEvidence(path.join(dataDir, 'data.db'), runId, evidence.maintenanceConfig.jobId);
  evidence.scheduler = { state: finalView.status?.lastRun?.status ?? finalView.status?.lastRun?.state ?? null,
    summary: finalView.status?.lastRun?.summary ?? null, error: finalView.status?.lastRun?.error ?? null,
    pendingSources: finalView.status?.pendingSources ?? null, attentionSources: finalView.status?.attentionSources ?? null };
  evidence.durable = durable;
  evidence.sourceMessages = durable.sourceMessages;
  const finalPages = { pageA: await get(`${api}/pages/${pageA.id}`), pageB: await get(`${api}/pages/${pageB.id}`), unrelated: await get(`${api}/pages/${unrelated.id}`), database: await get(`${api}/databases/${database.id}`) };
  const changesA = await get(`${api}/pages/${pageA.id}/changes?limit=100`);
  const changesB = await get(`${api}/pages/${pageB.id}/changes?limit=100`);
  const changes = [...(changesA.changes ?? []), ...(changesB.changes ?? [])];
  const rowAfter = finalPages.database.rows.find((row) => row.id === seedRow.id);
  const progressA = finalPages.pageA.blocks.find((block) => block.type === 'callout' && block.title === 'Progress');
  const progressB = finalPages.pageB.blocks.find((block) => block.type === 'callout' && block.title === 'Progress');
  const riskNowA = finalPages.pageA.blocks.find((block) => block.id === pageARisk.id);
  const riskNowB = finalPages.pageB.blocks.find((block) => block.id === pageBRisk.id);
  const proposals = changes.filter((change) => change.proposalState === 'pending' && change.target?.kind === 'block'
    && [pageARisk.id, pageBRisk.id].includes(change.target.blockId));
  evidence.changes = changes.map(summarizeChange);
  evidence.readback = { progressA: progressA?.text ?? null, progressB: progressB?.text ?? null,
    riskA: riskNowA?.text ?? null, riskB: riskNowB?.text ?? null,
    row: rowAfter ? { id: rowAfter.id, values: rowAfter.values, edited: rowAfter.edited } : null,
    pageARevision: finalPages.pageA.revision, pageBRevision: finalPages.pageB.revision,
    databaseRevision: finalPages.database.revision,
    databaseRefOnPageA: finalPages.pageA.blocks.some((block) => block.type === 'database-ref' && block.databaseId === database.id),
    databaseRefOnPageB: finalPages.pageB.blocks.some((block) => block.type === 'database-ref' && block.databaseId === database.id),
    databaseViewTypes: finalPages.database.views.map((view) => view.type),
    unrelated: { revision: finalPages.unrelated.revision, viewVersion: finalPages.unrelated.viewVersion, blocks: finalPages.unrelated.blocks },
    proposals: proposals.map(summarizeChange),
  };
  const receipt = durable.receipts.find((item) => item.evidence?.turnId === turn.summary.turnId) ?? durable.receipts[0];
  const source = receipt ? { kind: 'maintenance', ...receipt.execution, evidence: receipt.evidence, operationKey: receipt.operationKey } : null;
  evidence.attribution = source ? { kind: source.kind, nodeId: source.nodeId, turnId: source.turnId,
    assistantId: source.assistantId, jobId: evidence.maintenanceConfig.jobId, runId: source.runId,
    evidence: source.evidence, operationKey: source.operationKey } : null;
  evidence.checks.progressChangedBoth = Boolean(progressA?.text && progressB?.text && /8\.4|rollback/i.test(progressA.text) && /8\.4|rollback/i.test(progressB.text));
  evidence.checks.databaseSharedAcrossPages = evidence.readback.databaseRefOnPageA && evidence.readback.databaseRefOnPageB;
  evidence.checks.sharedRowUpdated = Boolean(rowAfter && rowAfter.values?.[taskColumn.id] === 'Validate staged rollback'
    && rowAfter.values?.[statusColumn.id] === 'In progress' && rowAfter.values?.[ownerColumn.id] === 'Release Engineering');
  evidence.checks.protectedRisksRemainHumanText = riskNowA?.text === 'Human reviewed: preserve staged rollback evidence.' && riskNowB?.text === 'Human reviewed: preserve staged rollback evidence.';
  evidence.checks.protectedRiskProposalExists = [pageARisk.id, pageBRisk.id].every((blockId) => proposals.some((proposal) => proposal.target?.blockId === blockId));
  evidence.checks.sourceAttributionPreserved = Boolean(receipt?.evidence?.nodeId === nodeId
    && receipt.evidence.turnId === turn.summary.turnId && receipt.evidence.assistantId === turn.summary.assistantId
    && source?.runId === runId && durable.sourceMessages?.some((message) => message.id === receipt.evidence.assistantId));
  evidence.checks.unrelatedPageUnchanged = finalPages.unrelated.revision === before.unrelated.revision
    && JSON.stringify(finalPages.unrelated.blocks) === JSON.stringify(before.unrelated.blocks);
  evidence.checks.tableBoardAgreement = finalPages.database.views.some((view) => view.type === 'board') && finalPages.database.views.some((view) => view.type === 'table')
    && finalPages.database.rows.some((row) => row.id === seedRow.id && row.values?.[statusColumn.id] === 'In progress');
  evidence.checks.durableCursorAdvanced = Boolean(durable.plan?.state === 'terminal' && durable.config?.completionCursor >= durable.plan.through
    && durable.sources.length > 0 && durable.sources.every((source) => source.state === 'terminal'));
  evidence.checks.dedicatedToolsActuallyCalled = durable.receipts.length > 0;
  evidence.result = Object.values(evidence.checks).every(Boolean) ? 'real_unattended_maintenance_passed' : 'partial_or_failed';
  evidence.checks.unrelatedPageExcludedAndUnchanged = !durable.resources.some((resource) => resource.kind === 'page' && resource.id === unrelated.id)
    && finalPages.unrelated.revision === before.unrelated.revision
    && JSON.stringify(finalPages.unrelated.blocks) === JSON.stringify(before.unrelated.blocks);
  evidence.result = Object.values(evidence.checks).every(Boolean) ? 'real_unattended_maintenance_passed' : 'partial_or_failed';
} catch (error) {
  evidence.error = sanitize(error instanceof Error ? error.message : String(error));
  if (evidence.run?.runId) {
    try { evidence.run.snapshot = await get(`${api}/scheduled-jobs/runs/${encodeURIComponent(evidence.run.runId)}`); } catch { /* backend may already be gone */ }
    try { evidence.maintenanceSnapshot = await get(`${api}/workspaces/${encodeURIComponent(evidence.ids.workspaceId)}/maintenance`); } catch { /* backend may already be gone */ }
    try { evidence.partialDurable = await readDurableMaintenanceEvidence(path.join(dataDir, 'data.db'), evidence.run.runId, evidence.maintenanceConfig.jobId); } catch (readError) {
      evidence.partialDurableError = sanitize(readError instanceof Error ? readError.message : String(readError));
    }
  }
  if (stderr || stdout) evidence.backendOutput = sanitize(`${stderr}\n${stdout}`).slice(-8000);
  await writeProgress(evidencePath, evidence);
  evidence.result = 'failed_or_incomplete';
} finally {
  await finalize();
}

async function finalize() {
  if (finalize.done) return;
  if (finalize.running) return finalize.running;
  finalize.running = (async () => {
    try {
      child.kill('SIGTERM');
      await waitChild(child, 6000);
      if (interruptedSignal && evidence.run?.runId) {
        try { evidence.run.snapshot = await get(`${api}/scheduled-jobs/runs/${encodeURIComponent(evidence.run.runId)}`); } catch { /* backend already stopped */ }
        try { evidence.maintenanceSnapshot = await get(`${api}/workspaces/${encodeURIComponent(evidence.ids?.workspaceId)}/maintenance`); } catch { /* backend already stopped */ }
        try { evidence.partialDurable = await readDurableMaintenanceEvidence(path.join(dataDir, 'data.db'), evidence.run.runId, evidence.maintenanceConfig?.jobId); } catch (error) {
          evidence.partialDurableError = sanitize(error instanceof Error ? error.message : String(error));
        }
      }
      if (stderr || stdout) evidence.backendOutput = sanitize(`${stderr}\n${stdout}`).slice(-8000);
      await writeProgress(evidencePath, evidence, true);
      console.log(JSON.stringify({ ...evidence, evidenceFile: path.relative(root, evidencePath) }, null, 2));
    } finally {
      finalize.done = true;
      await rm(temp, { recursive: true, force: true });
    }
  })();
  return finalize.running;
}
finalize.done = false;
finalize.running = null;

async function sendTurn(chatId, text) {
  const turnId = `ordinary-${randomUUID()}`;
  activeTurn = true;
  const response = await fetch(`${api}/chats/${encodeURIComponent(chatId)}/message`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, turnId }), signal: AbortSignal.timeout(6 * 60_000) });
  if (!response.ok) throw new Error(`Ordinary ChatHub turn failed (${response.status}): ${sanitize(await response.text())}`);
  const toolCalls = []; let attention = false; let assistantId = null; let streamedTurnId = null; let terminal = null;
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    pending += decoder.decode(value, { stream: true }); const frames = pending.split('\n\n'); pending = frames.pop() ?? '';
    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1]; const dataText = frame.match(/^data: (.+)$/m)?.[1]; if (!event || !dataText) continue;
      let data; try { data = JSON.parse(dataText); } catch { continue; }
      if (event === 'turn_start') { assistantId = data.assistantId ?? assistantId; streamedTurnId = data.turnId ?? streamedTurnId; }
      if (event === 'tool_call' || event === 'tool_call_update') toolCalls.push({ event, title: sanitize(data.title ?? ''), status: data.status ?? null });
      if (event === 'permission_request' || event === 'user_input_request') { attention = true; await post(`${api}/chats/${encodeURIComponent(chatId)}/cancel`, { turnId }); }
      if (event === 'done' || event === 'error') terminal = event;
    }
  }
  activeTurn = false;
  return { attention, summary: { requestedTurnId: turnId, turnId: streamedTurnId, assistantId, terminal, toolCalls } };
}
function riskBlock(blocks) { const i = blocks.findIndex((block) => block.type === 'heading' && block.text === 'Risks'); if (i < 0 || blocks[i + 1]?.type !== 'markdown') throw new Error('Release template lacks its Risks block.'); return blocks[i + 1]; }
function summarizeChange(c) { return { id: c.id, op: c.op, proposalState: c.proposalState, applicationState: c.applicationState, target: c.target,
  source: c.source ? { kind: c.source.kind, nodeId: c.source.nodeId, turnId: c.source.turnId, assistantId: c.source.assistantId, jobId: c.source.jobId, runId: c.source.runId, evidence: c.source.evidence, operationKey: c.source.operationKey } : null }; }
async function pollMaintenance(workspaceId, runId, evidence) {
  const timeoutMinutes = Math.max(3, Math.min(15, Number(
    process.env.MICHI_PAGES_MAINTENANCE_ACCEPTANCE_WAIT
      ?? process.env.MICHI_PAGES_ACCEPTANCE_TIMEOUT_MINUTES
      ?? 12,
  )));
  const until = Date.now() + timeoutMinutes * 60_000;
  const startedAt = Date.now();
  evidence.polls = [];
  let lastRecordedAt = 0;
  while (Date.now() < until) {
    const view = await get(`${api}/workspaces/${encodeURIComponent(workspaceId)}/maintenance`);
    const run = runId ? await get(`${api}/scheduled-jobs/runs/${encodeURIComponent(runId)}`).catch(() => null) : view.status?.lastRun;
    view.status.lastRun = run ?? view.status?.lastRun;
    if (Date.now() - lastRecordedAt >= 20_000) {
      lastRecordedAt = Date.now();
      const durable = await readDurableMaintenanceEvidence(path.join(dataDir, 'data.db'), runId, view.config?.jobId);
      evidence.polls.push({ elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), run: run ? {
        status: run.status, summary: sanitize(run.summary ?? '').slice(-1800), error: sanitize(run.error ?? '').slice(0, 800),
      } : null,
      cursor: durable.config?.completionCursor ?? null,
      plan: durable.plan ? { id: durable.plan.id, state: durable.plan.state, after: durable.plan.after, through: durable.plan.through } : null,
      sources: durable.sources.map((source) => ({ turnId: source.sourceTurnId, state: source.state, routingComplete: source.routingComplete })),
      resources: durable.resources.map((resource) => ({ kind: resource.kind, state: resource.state })),
      receiptOutcomes: durable.receipts.map((receipt) => receipt.outcome),
      maintenanceCalls: durable.maintenanceCalls,
      assistantTail: durable.conversation?.filter((item) => item.role === 'assistant').at(-1)?.content?.slice(-1400) ?? null,
      });
      await writeProgress(evidencePath, { result: 'running', runtimeId, backendSource: evidence.backendSource,
        isolation: evidence.isolation, runtime: evidence.runtime, ids: evidence.ids, maintenanceConfig: evidence.maintenanceConfig,
        run: evidence.run, checks: evidence.checks, polls: evidence.polls.slice(-12) });
    }
    if (run && ['succeeded', 'failed', 'cancelled', 'attention', 'interrupted'].includes(run.status ?? run.state)) return view;
    await delay(1000);
  }
  throw new Error(`Scheduled maintenance run did not reach a terminal state within ${timeoutMinutes} minutes.`);
}
async function readDurableMaintenanceEvidence(dbPath, runId, jobId) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const plan = db.prepare('SELECT id,run_id,state,after_seq,through_seq FROM page_maintenance_plans WHERE run_id=? AND job_id=?').get(runId, jobId);
    if (!plan) return { plan: null, config: null, sources: [], resources: [], receipts: [] };
    const sources = db.prepare('SELECT source_turn_id,completion_seq,state,routing_complete,evidence_json FROM page_maintenance_sources WHERE plan_id=? ORDER BY completion_seq').all(plan.id)
      .map((row) => ({ sourceTurnId: row.source_turn_id, completionSeq: row.completion_seq, state: row.state,
        routingComplete: Boolean(row.routing_complete), evidence: safeJson(row.evidence_json) }));
    const resources = db.prepare('SELECT resource_kind,resource_id,state,receipt_key,page_ids_json FROM page_maintenance_resources WHERE plan_id=? ORDER BY source_turn_id,resource_kind,resource_id').all(plan.id)
      .map((row) => ({ kind: row.resource_kind, id: row.resource_id, state: row.state, operationKey: row.receipt_key, pageIds: safeJson(row.page_ids_json) }));
    const receipts = db.prepare('SELECT receipt_key,source_turn_id,resource_kind,resource_id,outcome,result_json,execution_json,evidence_json FROM page_maintenance_receipts WHERE plan_id=? ORDER BY source_turn_id,resource_kind,resource_id').all(plan.id)
      .map((row) => ({ operationKey: row.receipt_key, sourceTurnId: row.source_turn_id, kind: row.resource_kind, resourceId: row.resource_id,
        outcome: row.outcome, result: safeJson(row.result_json), execution: safeJson(row.execution_json), evidence: safeJson(row.evidence_json) }));
    const config = db.prepare('SELECT completion_cursor,enabled,paused FROM page_maintenance_configs WHERE job_id=?').get(jobId);
    const run = db.prepare('SELECT node_id,tree_id,status,summary,error FROM scheduled_job_runs WHERE id=?').get(runId);
    const job = db.prepare('SELECT persistent_node_id FROM scheduled_jobs WHERE id=?').get(jobId);
    const maintenanceNodeId = run?.node_id ?? job?.persistent_node_id;
    const conversation = maintenanceNodeId ? db.prepare(`SELECT m.role,m.content,m.tool_calls FROM messages m WHERE m.node_id=? ORDER BY m.seq`).all(maintenanceNodeId)
      .map((row) => ({ role: row.role, content: sanitize(row.content).slice(-3000), toolCalls: summarizeToolCalls(safeJson(row.tool_calls)) })) : [];
    const maintenanceCalls = conversation.flatMap((message) => message.toolCalls ?? []);
    const sourceNodeId = sources[0]?.evidence?.nodeId;
    const sourceMessages = sourceNodeId ? db.prepare('SELECT id,role,content FROM messages WHERE node_id=? ORDER BY seq').all(sourceNodeId)
      .map((row) => ({ id: row.id, role: row.role, content: sanitize(row.content).slice(0, 3000) })) : [];
    return { plan: { id: plan.id, runId: plan.run_id, state: plan.state, after: plan.after_seq, through: plan.through_seq },
      config: config ? { completionCursor: config.completion_cursor, enabled: Boolean(config.enabled), paused: Boolean(config.paused) } : null,
      run: run ? { nodeId: run.node_id, treeId: run.tree_id, status: run.status, summary: run.summary, error: run.error } : null,
      maintenanceNodeId, conversation, maintenanceCalls, sources, sourceMessages, resources, receipts };
  } finally { db.close(); }
}
function safeJson(value) { try { return JSON.parse(value); } catch { return null; } }
async function writeProgress(file, value, full = false) {
  const snapshot = full ? value : value;
  const textValue = JSON.stringify(snapshot, null, 2) + '\n';
  await writeFile(file, textValue, { mode: 0o600 });
}
function summarizeToolCalls(value) {
  const found = [];
  const visit = (item) => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    if (!item || typeof item !== 'object') return;
    const name = item.name ?? item.toolName ?? item.tool_name ?? item.function?.name;
    if (typeof name === 'string' && name.startsWith('maintenance_')) found.push(name);
    for (const [key, child] of Object.entries(item)) if (key !== 'input' && key !== 'arguments') visit(child);
  };
  visit(value);
  return found;
}
async function reservePort() { const net = await import('node:net'); const s = net.createServer(); await new Promise((r, j) => s.once('error', j).listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r, j) => s.close((e) => e ? j(e) : r())); return p; }
async function waitReady(base, proc) { const until = Date.now() + 60_000; while (Date.now() < until) { if (proc.exitCode !== null) return false; try { if ((await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).ok) return true; } catch {} await delay(250); } return false; }
async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`GET ${new URL(url).pathname}: HTTP ${r.status} ${sanitize(await r.text())}`); return r.json(); }
async function post(url, body) { return request(url, 'POST', body); }
async function patch(url, body) { return request(url, 'PATCH', body); }
async function request(url, method, body) { const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) }); if (!r.ok) throw new Error(`${method} ${new URL(url).pathname}: HTTP ${r.status} ${sanitize(await r.text())}`); return r.status === 204 ? null : r.json(); }
function sanitize(v) { return String(v ?? '').replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|AKIA[0-9A-Z]{16})/g, '[redacted]').slice(0, 4000); }
function waitChild(proc, ms) { if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(); return Promise.race([new Promise((r) => proc.once('exit', r)), delay(ms).then(() => proc.kill('SIGKILL'))]); }
