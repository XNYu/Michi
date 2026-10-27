#!/usr/bin/env node

/**
 * Disposable ordinary-chat acceptance for native Pages and component tools.
 * The script will not invoke a model unless --execute is supplied. It starts
 * a local backend with fresh MICHI_DATA_DIR/MICHI_CONFIG_DIR/MICHI_LOG_DIR,
 * seeds one temporary workspace/page/chat, uses the registered runtime and
 * ChatHub APIs, records bounded sanitized evidence under docs/superpowers/plans,
 * and deletes all temporary application state when it exits.
 *
 * Run only after root integration readiness is confirmed:
 *   node scripts/pages-real-runtime-acceptance.mjs --runtime claude --execute
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { directNativePageTool, findCompletedNativeToolCall, isOneTimePagePermissionAllowed,
  wrappedNativePageTool, boundEvidence } from './pages-real-runtime-helpers.mjs';

const root = path.resolve(import.meta.dirname, '..');
const runtimeIndex = process.argv.indexOf('--runtime');
const runtimeId = runtimeIndex >= 0 ? process.argv[runtimeIndex + 1] : null;
const execute = process.argv.includes('--execute');
const useBackendBundle = process.env.MICHI_PAGES_ACCEPTANCE_USE_BUNDLE === '1';
const coreOnly = process.argv.includes('--core-only');
const turnTimeoutMs = 4 * 60_000;
const allowedRuntimes = new Set(['kiro', 'crew', 'pi', 'claude', 'codex']);
// This disposable acceptance harness may grant only one native Pages approval
// at a time. Never persist grants or approve general-purpose capabilities.
const oneTimePageTools = new Set([
  'list_pages', 'read_page', 'create_page', 'edit_page', 'read_database',
  'edit_database', 'list_page_components', 'read_page_component',
  'save_page_component', 'configure_database_view', 'michi_docs',
  'michi_list_tools', 'michi_call_tool',
]);
const nativePageTools = new Set([...oneTimePageTools].filter((name) => !name.startsWith('michi_')));
if (!runtimeId || !allowedRuntimes.has(runtimeId)) {
  throw new Error('Choose --runtime kiro|crew|pi|claude|codex');
}
if (!execute) {
  console.log('Preflight-only mode. Add --execute after the root confirms integrated backend readiness to send real model turns.');
  process.exit(0);
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'michi-pages-real-'));
const workspaceCwd = path.join(temp, 'workspace');
const dataDir = path.join(temp, 'data');
const configDir = path.join(temp, 'config');
const logDir = path.join(temp, 'logs');
await mkdir(workspaceCwd);
const port = await reservePort();
const backendArgs = useBackendBundle ? ['dist/server.js'] : ['--require', 'ts-node/register', 'src/server.ts'];
const child = spawn(process.execPath, backendArgs, {
  cwd: path.join(root, 'backend'),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
    MICHI_DATA_DIR: dataDir, MICHI_CONFIG_DIR: configDir, MICHI_LOG_DIR: logDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
let stdout = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000); });
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
const api = `http://127.0.0.1:${port}/api`;
const record = { result: 'incomplete', runtimeId, isolation: 'disposable backend, config, data, logs, workspace cwd',
  backend: useBackendBundle ? 'backend/dist/server.js bundle' : 'backend/src/server.ts via ts-node',
  approvalScope: { mode: 'one-time only', tools: [...oneTimePageTools], deniedToolsAreCancelled: true }, events: [], checks: {} };
let nodeId;
let streamedChat = false;

try {
  if (!await waitReady(api, child)) throw new Error(`Backend readiness failed: ${sanitize(stderr).slice(0, 2500)}`);
  const auth = await json(`${api}/auth-config`);
  if (auth.requireAuth === true) throw new Error('Backend requires an authenticated UI session; runner will not bypass it.');

  // Inventory every registered ordinary runtime through existing settings
  // APIs. Selection is persisted only in this runner's temporary config dir.
  const initialStatus = await json(`${api}/agent/status`);
  record.registeredRuntimes = (initialStatus.availableRuntimes ?? []).map((item) => ({
    id: item.id, available: item.available === true,
    ...(item.unavailableReason ? { unavailableReason: sanitize(item.unavailableReason) } : {}),
  }));
  const selected = record.registeredRuntimes.find((item) => item.id === runtimeId);
  if (!selected) throw new Error(`Runtime ${runtimeId} is not registered by this backend.`);
  if (!selected.available) throw new Error(`Runtime ${runtimeId} unavailable: ${selected.unavailableReason ?? 'availability probe failed'}`);

  await post(`${api}/agent/options`, { runtime: runtimeId });
  const status = await json(`${api}/agent/status`);
  record.runtime = {
    id: runtimeId, label: status.label, provider: status.provider ?? null,
    model: status.model ?? null, hasRequiredKey: status.hasRequiredKey === true,
    providers: (status.providers ?? []).map((provider) => ({ id: provider.id,
      hasKey: provider.hasKey === true, ready: provider.ready === true,
      requiresUserKey: provider.requiresUserKey === true })),
  };
  if (runtimeId === 'pi' && status.hasRequiredKey !== true) {
    throw new Error(`Pi provider ${status.provider ?? '(none)'} is not configured according to /agent/status.`);
  }
  if (runtimeId === 'crew' && !status.capabilities?.permissions) {
    throw new Error('Crew runtime is registered but does not expose its ordinary approval capability.');
  }

  const workspaceId = `pages-acceptance-${randomUUID()}`;
  const treeId = `tree-${randomUUID()}`;
  nodeId = `node-${randomUUID()}`;
  const now = Date.now();
  await post(`${api}/workspaces/${encodeURIComponent(workspaceId)}/graph/nodes/ensure`, {
    workspace: { id: workspaceId, name: `Pages acceptance ${runtimeId}`, cwd: workspaceCwd, createdAt: now, activeTreeId: treeId },
    tree: { id: treeId, rootNodeId: nodeId, name: 'Acceptance', createdAt: now, lastActiveAt: now },
    node: { id: nodeId, treeId, kind: 'chat', title: 'Pages acceptance', createdAt: now },
    edges: [],
  });
  const page = await post(`${api}/workspaces/${encodeURIComponent(workspaceId)}/pages`, {
    title: `Pages acceptance ${runtimeId}`, template: 'release',
  });
  record.ids = { workspaceId, treeId, nodeId, pageId: page.id };

  const riskBlock = riskBlockFor(page.blocks);
  await post(`${api}/pages/${encodeURIComponent(page.id)}/edits`, {
    revision: page.revision,
    ops: [{ op: 'update', id: riskBlock.id, expectRev: riskBlock.rev,
      block: { type: 'markdown', text: 'Owner-reviewed: deploy only after rollback rehearsal.' } }],
  });
  const databases = await json(`${api}/workspaces/${encodeURIComponent(workspaceId)}/databases`);
  const database = (databases.items ?? []).find((item) => item.title === 'Release checklist');
  if (!database) throw new Error('Release page template did not create its checklist database.');
  const taskColumn = database.columns.find((column) => column.name === 'Task');
  const statusColumn = database.columns.find((column) => column.name === 'Status');
  const seedRow = database.rows[0];
  await post(`${api}/databases/${encodeURIComponent(database.id)}/edits`, {
    revision: database.revision,
    ops: [
      { op: 'row.update', id: seedRow.id, expectRev: seedRow.rev, values: { [taskColumn.id]: 'Validate rollback rehearsal' } },
      { op: 'view.save', view: { name: 'Acceptance table', type: 'table', config: { filters: [], match: 'all', sorts: [] } } },
    ],
  });
  record.ids.databaseId = database.id;
  record.seed = { protectedRiskBlockId: riskBlock.id, checklistRowId: seedRow.id,
    taskColumnId: taskColumn.id, statusColumnId: statusColumn.id };

  const session = await post(`${api}/nodes/${encodeURIComponent(nodeId)}/ensure-session`, {
    nodeId, workspaceId, cwd: workspaceCwd, runtimeId,
    ...(status.provider ? { providerId: status.provider } : {}),
    ...(status.model ? { modelId: status.model } : {}),
    permissionMode: 'ask',
  });
  record.session = { runtimeId: session.runtimeId, providerId: session.providerId ?? null,
    modelId: session.modelId ?? null, resumeStrategy: session.resumeStrategy ?? null };
  const chatId = session.chatId ?? nodeId;
  record.ids.chatId = chatId;

  const childTitle = `Runtime-created-${runtimeId}`;
  const createReadTurn = await sendTurn(api, chatId, [
    'Use only the specified native Pages tools for this request. If the runtime exposes them through Michi wrappers, first use `michi_list_tools` to discover the exact available Pages tool names, then use `michi_call_tool` only as a transport wrapper for those exact native Pages calls. Do not use the wrappers for any other capability. Do not call shell, file, network, docs, branch overview, or any other tools unless necessary to resolve the Page operation.',
    `Call list_pages for this workspace, then create_page exactly once to create a child Page titled "${childTitle}" under parent Page ${page.id} using the research template. Call read_page on the returned Page ID and report its title and ID. Do not call set_branch_overview.`,
  ].join('\n'), record, nodeId);
  record.turns = [createReadTurn.summary];
  if (createReadTurn.attention) throw new Error(`Page create/read turn needs user attention (${createReadTurn.attention}); it was cancelled without auto-approval.`);
  const pageIndex = await json(`${api}/workspaces/${encodeURIComponent(workspaceId)}/pages?parentId=${encodeURIComponent(page.id)}`);
  const createdByRuntime = (pageIndex.items ?? []).find((item) => item.title === childTitle);
  if (!createdByRuntime) throw new Error('Real runtime did not create the requested child Page through create_page.');
  const createdPage = await json(`${api}/pages/${encodeURIComponent(createdByRuntime.id)}`);
  const creationSource = createdPage.blocks.flatMap((block) => block.sources ?? []).find((source) => source.nodeId === nodeId);
  record.toolCreatedPage = { id: createdPage.id, title: createdPage.title, parentId: createdPage.parentId,
    source: creationSource ?? null, blockCount: createdPage.blocks.length };
  record.checks.pageCreatedByTool = Boolean(creationSource?.turnId && creationSource?.assistantId);
  const readBackCall = findCompletedNativeToolCall(createReadTurn.summary.toolCalls, 'read_page', createReadTurn.summary.turnId);
  record.pageReadBackToolCall = readBackCall ? { toolCallId: readBackCall.toolCallId,
    turnId: readBackCall.turnId, status: readBackCall.status, inputJson: readBackCall.inputJson } : null;
  record.checks.pageReadBackByTool = Boolean(readBackCall);

  const seededDb = await json(`${api}/databases/${encodeURIComponent(database.id)}`);
  const board = seededDb.views.find((view) => view.type === 'board');
  const table = seededDb.views.find((view) => view.name === 'Acceptance table');
  if (!board || !table) throw new Error('Required shared board/table views are missing.');

  const pageWritePrompt = [
    'Use only native Pages tools for this short Page read/write stage. If available through Michi wrappers, discover names with `michi_list_tools` and use `michi_call_tool` only for the exact Pages tool names. Do not use shell, files, web, docs, or other capabilities.',
    `Read Page ${page.id}. Update only its unprotected Progress callout to say exactly "Disposable runtime smoke complete". Read that Page again and report the native receipt.`,
  ].join('\n');
  const pageWriteTurn = await sendTurn(api, chatId, pageWritePrompt, record, nodeId);
  record.turns.push(pageWriteTurn.summary);
  record.stageTurns ??= {};
  record.stageTurns.pageWrite = pageWriteTurn.summary;
  if (pageWriteTurn.attention) throw new Error(`Page write turn needs user attention (${pageWriteTurn.attention}); it was cancelled without auto-approval.`);

  const afterPage = await json(`${api}/pages/${encodeURIComponent(page.id)}`);
  record.stageReadback ??= {};
  record.stageReadback.pageAfterWrite = { revision: afterPage.revision,
    progress: afterPage.blocks.find((block) => block.type === 'callout' && block.title === 'Progress')?.text,
    risks: afterPage.blocks.find((block) => block.id === riskBlock.id)?.text };

  const proposalPrompt = [
    'Use only native Pages tools for this short protected-write stage. If available through Michi wrappers, discover names with `michi_list_tools` and use `michi_call_tool` only for the exact Pages tool names. Do not use shell, files, web, docs, or other capabilities.',
    `Attempt to change only the human-edited Risks block ${riskBlock.id} on Page ${page.id} to "No release-blocking risks". If protected, report it as a proposal, do not claim it was applied, and read the Page to confirm the human text remains unchanged.`,
  ].join('\n');
  const proposalTurn = await sendTurn(api, chatId, proposalPrompt, record, nodeId);
  record.turns.push(proposalTurn.summary);
  record.stageTurns.protectedProposal = proposalTurn.summary;
  if (proposalTurn.attention) throw new Error(`Protected proposal turn needs user attention (${proposalTurn.attention}); it was cancelled without auto-approval.`);

  const databaseWritePrompt = [
    'Use only native Pages database tools for this read and write. If available through Michi wrappers, discover names with `michi_list_tools` and use `michi_call_tool` only for the exact Pages tool names. Do not use shell, files, web, docs, or other capabilities.',
    `Read database ${database.id}. Update only row ${seedRow.id} so Status column ${statusColumn.id} becomes exactly "doing". Preserve the human-owned Task column ${taskColumn.id} unchanged. Read the database again and report the native receipt.`,
  ].join('\n');
  const databaseWriteTurn = await sendTurn(api, chatId, databaseWritePrompt, record, nodeId);
  record.turns.push(databaseWriteTurn.summary);
  record.stageTurns.databaseWrite = databaseWriteTurn.summary;
  if (databaseWriteTurn.attention) throw new Error(`Database write turn needs user attention (${databaseWriteTurn.attention}); it was cancelled without auto-approval.`);

  const afterDb = await json(`${api}/databases/${encodeURIComponent(database.id)}`);
  const afterRow = afterDb.rows.find((item) => item.id === seedRow.id);
  const changes = await json(`${api}/pages/${encodeURIComponent(page.id)}/changes?limit=100`);
  const latestPage = await json(`${api}/pages/${encodeURIComponent(page.id)}`);
  const latestRisk = latestPage.blocks.find((block) => block.id === riskBlock.id);
  const latestProgress = latestPage.blocks.find((block) => block.type === 'callout' && block.title === 'Progress');
  const rowState = afterRow;
  record.checks.ordinaryPageProgress = latestProgress?.text === 'Disposable runtime smoke complete';
  record.checks.humanRiskPreserved = latestRisk?.text === 'Owner-reviewed: deploy only after rollback rehearsal.';
  record.checks.checklistStatusUpdated = rowState?.values?.[statusColumn.id] === 'doing';
  record.checks.humanTaskPreserved = rowState?.values?.[taskColumn.id] === 'Validate rollback rehearsal';
  record.checks.boardTableReferenceIntegrity = afterDb.views.some((view) => view.id === board.id)
    && afterDb.views.some((view) => view.id === table.id) && afterDb.rows.some((item) => item.id === seedRow.id);
  record.pageChanges = summarizeChanges(changes.changes ?? []);
  const pageProgressChange = (changes.changes ?? []).find((change) => change.target?.kind === 'block'
    && change.target.blockId === latestProgress?.id && change.source?.turnId === pageWriteTurn.summary.turnId
    && change.applicationState === 'applied');
  const statusChange = (changes.changes ?? []).find((change) => change.target?.kind === 'row'
    && change.target.rowId === seedRow.id && change.target.columnIds?.includes(statusColumn.id)
    && change.source?.turnId === databaseWriteTurn.summary.turnId && change.applicationState === 'applied');
  record.checks.pageEditAttributed = Boolean(pageProgressChange?.source?.assistantId);
  record.checks.databaseEditAttributed = Boolean(statusChange?.source?.assistantId);
  const proposalChange = (changes.changes ?? []).find((change) => change.target?.kind === 'block'
    && change.target.blockId === riskBlock.id && change.source?.turnId === proposalTurn.summary.turnId
    && change.proposalState === 'pending');
  record.protectedProposalChange = proposalChange ? summarizeChanges([proposalChange])[0] : null;
  record.stageReadback.databaseAfterWrite = { revision: afterDb.revision, row: rowState ? {
    id: rowState.id, rev: rowState.rev, values: rowState.values,
    editedColumnIds: Object.keys(rowState.edited) } : null };
  record.readback = { pageRevision: latestPage.revision, viewVersion: latestPage.viewVersion,
    progress: latestProgress?.text, risks: latestRisk?.text,
    row: rowState ? { values: rowState.values, editedColumnIds: Object.keys(rowState.edited) } : null,
    views: afterDb.views.map((view) => ({ id: view.id, name: view.name, type: view.type })) };
  await acceptUndoRedoRiskProposal(api, page.id, riskBlock.id, record, proposalTurn.summary.turnId);
  if (coreOnly) {
    record.limitations = ['Generated component and browser rendering gates were not requested in this core-only runtime run.'];
    const coreNames = ['pageCreatedByTool', 'pageReadBackByTool', 'ordinaryPageProgress', 'pageEditAttributed',
      'humanRiskPreserved', 'protectedRiskProposalFound', 'riskProposalAccepted',
      'riskProposalUndoRestoredHumanText', 'riskProposalRedoRestoredAcceptedText',
      'checklistStatusUpdated', 'databaseEditAttributed', 'humanTaskPreserved',
      'boardTableReferenceIntegrity', 'originalSourceMessagePresent'];
    const coreChecks = Object.fromEntries(coreNames.map((name) => [name, record.checks[name] === true]));
    record.groups = { core: { passed: Object.values(coreChecks).every(Boolean), checks: coreChecks },
      generatedComponent: { skipped: true }, browser: { skipped: true } };
    record.result = record.groups.core.passed ? 'core_api_and_ordinary_chat_checks_passed' : 'partial_or_failed';
  } else {
    await runComponentTurn(api, chatId, { pageId: page.id, databaseId: database.id,
    databaseRevision: afterDb.revision, tableViewId: table.id, pageRevision: afterPage.revision,
    pageTailId: afterPage.blocks.at(-1)?.id }, record, nodeId);

  const componentList = await json(`${api}/workspaces/${encodeURIComponent(workspaceId)}/components`);
  const finalPage = await json(`${api}/pages/${encodeURIComponent(page.id)}`);
  const finalDb = await json(`${api}/databases/${encodeURIComponent(database.id)}`);
  record.componentReadback = {
    libraryRevision: componentList.revision,
    items: (componentList.items ?? []).map((item) => ({ id: item.id, name: item.name,
      activeVersion: item.activeVersion, versions: item.versions })),
    pageBlocks: finalPage.blocks.filter((block) => block.type === 'component').map((block) => ({
      id: block.id, componentId: block.componentId, pinnedVersion: block.pinnedVersion ?? null, props: block.props,
    })),
    customViews: finalDb.views.filter((view) => view.type === 'custom').map((view) => ({
      id: view.id, name: view.name, componentId: view.config.componentId, pinnedVersion: view.config.pinnedVersion ?? null,
    })),
  };
  const generatedComponent = record.componentReadback.items.find((item) => item.name === 'release-risk-meter');
  if (generatedComponent) {
    const version = await json(`${api}/components/${encodeURIComponent(generatedComponent.id)}?workspaceId=${encodeURIComponent(workspaceId)}&version=${generatedComponent.activeVersion}`);
    const sourceArtifact = `docs/superpowers/plans/pages-real-runtime-evidence/${runtimeId}-release-risk-meter-v${version.version}.js`;
    await writeFile(path.join(root, sourceArtifact), version.code, { mode: 0o600 });
    record.generatedComponent = { id: generatedComponent.id, name: generatedComponent.name,
      version: version.version, code: version.code, propsSchema: version.propsSchema,
      source: version.source, sourceArtifact, sha256: createHash('sha256').update(version.code).digest('hex'),
      intendedHost: 'custom_database_view', props: { title: 'Release risk summary' } };
  }
  if (record.customViewProposal && record.customViewProposal.changeId) {
    const componentId = record.componentReadback.items.find((item) => item.name === 'pages-acceptance-widget')?.id;
    record.customViewProposal.readBack = record.componentReadback.customViews.some((view) => view.componentId === componentId);
    record.checks.customViewProposalAccepted = record.customViewProposal.state === 'accepted';
    record.checks.customViewProposalReadBack = record.customViewProposal.readBack;
  }
  record.checks.componentSaved = record.componentReadback.items.some((item) => item.name === 'release-risk-meter');
  record.checks.componentInserted = record.componentReadback.pageBlocks.length > 0;
  record.checks.customDatabaseViewConfigured = record.componentReadback.customViews.length > 0;
  record.checks.previewRendered = false;
  record.limitations = ['UI preview/rendering, source-jump interaction, and native browser visibility were not exercised by this HTTP/ChatHub runner.'];
  const coreCheckNames = ['pageCreatedByTool', 'pageReadBackByTool', 'ordinaryPageProgress',
    'pageEditAttributed', 'humanRiskPreserved', 'checklistStatusUpdated', 'databaseEditAttributed',
    'humanTaskPreserved', 'boardTableReferenceIntegrity',
    'protectedRiskProposalFound', 'riskProposalAccepted', 'riskProposalUndoRestoredHumanText',
    'riskProposalRedoRestoredAcceptedText', 'originalSourceMessagePresent'];
  const coreChecks = Object.fromEntries(coreCheckNames.map((name) => [name, record.checks[name] === true]));
  record.groups = {
    core: { passed: Object.values(coreChecks).every(Boolean), checks: coreChecks },
    generatedComponent: { saved: record.checks.componentSaved === true,
      pageInserted: record.checks.componentInserted === true,
      customDatabaseViewConfigured: record.checks.customDatabaseViewConfigured === true,
      previewRendered: false },
    browser: { previewRendered: false, sourceJumpExercised: false },
  };
  record.result = record.groups.core.passed
    ? 'core_api_and_ordinary_chat_checks_passed_component_or_browser_partial'
    : 'partial_or_failed';
  }
} catch (error) {
  record.error = sanitize(error instanceof Error ? error.message : String(error));
  record.result = 'failed_or_incomplete';
} finally {
  if (streamedChat && nodeId) {
    // A pending approval/input was explicitly cancelled in sendTurn; this is
    // best-effort cleanup for transport errors while a real turn was active.
    try {
      const turnId = record.turnEnvelope?.turnId;
      if (turnId) await post(`${api}/chats/${encodeURIComponent(nodeId)}/cancel`, { turnId });
    } catch { /* backend may already be exiting */ }
  }
  if (record.result === 'failed_or_incomplete') {
    record.backendDiagnostics = { stdout: sanitize(stdout).slice(-3000), stderr: sanitize(stderr).slice(-3000) };
    record.failureSnapshot = await captureFailureSnapshot(api, record.ids).catch((error) => ({
      unavailable: sanitize(error instanceof Error ? error.message : String(error)),
    }));
  }
  child.kill('SIGTERM');
  await waitChild(child, 6000);
  try {
    const evidenceDir = path.join(root, 'docs/superpowers/plans/pages-real-runtime-evidence');
    await mkdir(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, `${runtimeId}-${new Date().toISOString().replaceAll(':', '-')}.json`);
    await writeFile(evidencePath, JSON.stringify(boundEvidence(record, undefined, sanitize), null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ...record, evidenceFile: path.relative(root, evidencePath) }, null, 2));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function runComponentTurn(apiBase, chatId, targets, record, node) {
  const latestDatabase = await json(`${apiBase}/databases/${encodeURIComponent(targets.databaseId)}`);
  targets.databaseRevision = latestDatabase.revision;
  const prompt = [
    'Use only native Pages/component tools needed for the requested work. If the runtime exposes them through Michi wrappers, discover tool names with `michi_list_tools` and call `michi_call_tool` only as transport for those exact native Pages/component tools. Never use shell, files, web, unrelated tools, or access to anything outside this disposable workspace.',
    'Read the bundled `pages-and-components` docs and the current component library. Generate the component JavaScript yourself from the documented sandbox and host-data contracts; do not copy a code example verbatim and do not put source code in your chat reply.',
    'Save a component named "release-risk-meter" with description "Summarizes checklist status and offers a protected task proposal" and props schema {"type":"object","properties":{"title":{"type":"string"}},"required":["title"],"additionalProperties":false}.',
    'The component will run in both a custom database-view host with `data.database`, `data.columns` and `data.rows`, and a page-block host whose data may be empty or have a different shape. Each database row has `id`, `rev` and `values` keyed by column ID. Generate code that safely handles both hosts: use the same status summary when rows/columns exist and a clear “Open the Release checklist custom view for live data” fallback when they do not. Find Task and Status columns by name, count completed rows, and list task/status pairs. Use only the virtual root/document APIs documented in Michi docs; update the existing tree through `globalThis.onMichiComponentUpdate` when props or data change. Do not use browser globals, network APIs, innerHTML, canvas, SVG, or external packages.',
    'Include a button labeled "Propose task change". On click, request one row update through `call("write.rows", ops)` for the first row, setting only its human-owned Task cell to "Model-proposed acceptance task" and using the row’s current `expectRev`. Display whether the returned result contains a proposal; do not claim the row changed when it was only proposed.',
    `After the save succeeds, use edit_page to insert a component block on page ${targets.pageId} that references the saved component ID/version with props {"title":"Release risk summary"}. Then configure a NEW custom view on database ${targets.databaseId} by omitting viewId, pin it to the saved version, and use database revision ${targets.databaseRevision} with props {"title":"Release risk summary"}. Read the library, page, and database again. Report saved name/version and receipts without claiming UI rendering.`,
  ].join('\n');
  const turn = await sendTurn(apiBase, chatId, prompt, record, node);
  record.turns.push(turn.summary);
  if (turn.attention) throw new Error(`Component turn needs user attention (${turn.attention}); it was cancelled without auto-approval.`);
  const changePage = await json(`${apiBase}/pages/${encodeURIComponent(targets.pageId)}/changes?limit=100`);
  const viewProposal = (changePage.changes ?? []).find((change) => change.proposalState === 'pending'
    && change.target?.kind === 'database' && change.target.databaseId === targets.databaseId);
  if (viewProposal?.id) {
    const accepted = await post(`${apiBase}/page-changes/${encodeURIComponent(viewProposal.id)}/accept`, {});
    record.customViewProposal = { changeId: viewProposal.id, source: viewProposal.source,
      state: accepted?.proposalState ?? accepted?.change?.proposalState ?? null };
  } else {
    record.customViewProposal = { found: false };
  }
}

async function acceptUndoRedoRiskProposal(apiBase, pageId, riskBlockId, record, sourceTurnId) {
  const matching = record.pageChanges.find((change) => change.proposalState === 'pending'
    && change.target?.kind === 'block' && change.target.blockId === riskBlockId
    && (!sourceTurnId || change.source?.turnId === sourceTurnId));
  if (!matching?.id) {
    record.checks.protectedRiskProposalFound = false;
    return;
  }
  record.checks.protectedRiskProposalFound = true;
  const accepted = await post(`${apiBase}/page-changes/${encodeURIComponent(matching.id)}/accept`, {});
  const acceptedPage = await json(`${apiBase}/pages/${encodeURIComponent(pageId)}`);
  const acceptedRisk = acceptedPage.blocks.find((block) => block.id === riskBlockId);
  record.riskLifecycle = { changeId: matching.id, source: matching.source,
    acceptedState: accepted?.proposalState ?? accepted?.change?.proposalState ?? null,
    acceptedText: acceptedRisk?.text ?? null };
  await post(`${apiBase}/page-changes/${encodeURIComponent(matching.id)}/revert`, {});
  const undonePage = await json(`${apiBase}/pages/${encodeURIComponent(pageId)}`);
  const undoneRisk = undonePage.blocks.find((block) => block.id === riskBlockId);
  record.riskLifecycle.undoneText = undoneRisk?.text ?? null;
  await post(`${apiBase}/page-changes/${encodeURIComponent(matching.id)}/redo`, {});
  const redonePage = await json(`${apiBase}/pages/${encodeURIComponent(pageId)}`);
  const redoneRisk = redonePage.blocks.find((block) => block.id === riskBlockId);
  record.riskLifecycle.redoneText = redoneRisk?.text ?? null;
  const expectedProposedText = 'No release-blocking risks';
  record.checks.riskProposalAccepted = acceptedRisk?.text === expectedProposedText;
  record.checks.riskProposalUndoRestoredHumanText = undoneRisk?.text === 'Owner-reviewed: deploy only after rollback rehearsal.';
  record.checks.riskProposalRedoRestoredAcceptedText = redoneRisk?.text === expectedProposedText;
  const treeId = record.ids.treeId;
  const messages = await json(`${apiBase}/workspaces/${encodeURIComponent(record.ids.workspaceId)}/trees/${encodeURIComponent(treeId)}/messages`);
  const assistantId = matching.source?.assistantId;
  record.checks.originalSourceMessagePresent = Array.isArray(messages.messages)
    && messages.messages.some((message) => message.id === assistantId || message.messageId === assistantId);
  record.riskLifecycle.sourceMessagePresent = record.checks.originalSourceMessagePresent;
}

async function sendTurn(apiBase, chatId, text, record, node) {
  const turnId = `acceptance-${randomUUID()}`;
  const activeTurn = { requestedTurnId: turnId, toolCalls: [], permissions: [], textCharacters: 0,
    terminal: 'pending' };
  record.activeTurn = activeTurn;
  streamedChat = true;
  const response = await fetch(`${apiBase}/chats/${encodeURIComponent(chatId)}/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, turnId }), signal: AbortSignal.timeout(turnTimeoutMs),
  });
  if (!response.ok) {
    const message = `ChatHub message failed with HTTP ${response.status}: ${sanitize(await response.text())}`;
    activeTurn.error = message;
    throw new Error(message);
  }
  let attention = null;
  const collected = [];
  const decoder = new TextDecoder();
  const seenPermissionRequests = new Set();
  let turnTerminated = false;
  let pending = '';
  const reader = response.body.getReader();
  while (true) {
    let next;
    try { next = await reader.read(); }
    catch (error) {
      activeTurn.error = sanitize(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      activeTurn.toolEventCount = collected.length;
          activeTurn.toolCalls = collected.slice(-30).map(summarizeToolCall);
      throw error;
    }
    const { done, value } = next;
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const frames = pending.split('\n\n');
    pending = frames.pop() ?? '';
    for (const frame of frames) {
      const eventLine = frame.split('\n').find((line) => line.startsWith('event: '));
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice(7);
      let data;
      try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }
      if (event === 'turn_start') record.turnEnvelope = { turnId: data.turnId, assistantId: data.assistantId, nodeId: data.nodeId };
      if (event === 'chunk' && typeof data.text === 'string') {
        // Preserve only a bounded, sanitized transcript excerpt so acceptance
        // evidence can distinguish a real completed answer from tool activity.
        const current = record.assistantText ?? '';
        record.assistantText = sanitize(`${current}${data.text}`).slice(-12_000);
        activeTurn.textCharacters += data.text.length;
      }
      if (event === 'tool_call' || event === 'tool_call_update') {
        const item = { event, turnId: data.turnId ?? turnId, assistantId: data.assistantId,
          toolCallId: data.toolCallId,
          title: sanitize(data.title ?? ''), status: data.status ?? null,
          detail: sanitize(data.detail ?? ''), inputJson: sanitize(data.inputJson ?? ''),
          output: sanitize(data.output ?? '') };
        item.nativeTool = directNativePageTool(item.title);
        if (!item.nativeTool && item.title.toLowerCase().endsWith('michi_call_tool')) {
          const priorSameCall = item.toolCallId
            ? collected.findLast((previous) => previous.toolCallId === item.toolCallId
              && previous.turnId === item.turnId && previous.title.toLowerCase().endsWith('michi_call_tool'))
            : null;
          if (item.inputJson) item.nativeTool = wrappedNativePageTool({ inputJson: item.inputJson });
          else if (priorSameCall?.nativeTool) item.nativeTool = priorSameCall.nativeTool;
          else if (priorSameCall?.inputJson) item.nativeTool = wrappedNativePageTool({ inputJson: priorSameCall.inputJson });
        }
        collected.push(item);
        activeTurn.toolCalls.push(summarizeToolCall(item));
        if (activeTurn.toolCalls.length > 40) activeTurn.toolCalls.shift();
        if (event === 'tool_call_update') {
          record.toolOutputs ??= [];
          record.toolOutputs.push({ title: item.title, status: item.status,
            output: item.output.slice(0, 1200), turnId: item.turnId,
            assistantId: item.assistantId });
          if (record.toolOutputs.length > 12) record.toolOutputs.shift();
        }
        if (event === 'tool_call_update' && data.output && data.output.includes('michiPageWrite')) {
          try { record.events.push({ ...item, output: boundOutput(JSON.parse(data.output)) }); }
          catch { record.events.push({ ...item, output: data.output.slice(0, 3000) }); }
        }
        if (event === 'tool_call_update' && /failed|error/i.test(String(data.status ?? ''))) {
          record.events.push({ event: 'tool_call_failed', title: item.title,
            status: item.status, detail: item.detail.slice(0, 1200), output: item.output.slice(0, 1200) });
        }
      }
      if (event === 'permission_request') {
        const requestedTool = permissionToolName(data.title ?? data.toolName ?? '');
        const innerPageTool = requestedTool === 'michi_call_tool' ? wrappedNativePageTool(data) : null;
        const permissionKey = `${data.turnId ?? turnId}:${data.requestId}`;
        if (seenPermissionRequests.has(permissionKey)) {
          activeTurn.permissions.push({ requestId: data.requestId, tool: requestedTool, result: 'duplicate_ignored' });
          record.events.push({ event: 'permission_request_duplicate_ignored', tool: requestedTool,
            requestId: data.requestId, turnId: data.turnId ?? turnId });
          continue;
        }
        seenPermissionRequests.add(permissionKey);
        if (turnTerminated) {
          activeTurn.permissions.push({ requestId: data.requestId, tool: requestedTool, result: 'after_terminal_ignored' });
          record.events.push({ event: 'permission_request_after_terminal_ignored', tool: requestedTool,
            requestId: data.requestId, turnId: data.turnId ?? turnId });
          continue;
        }
        const allowOption = (data.options ?? []).find((option) => {
          const label = String(option.name ?? option.label ?? '').trim().toLowerCase();
          return ['yes', 'allow once', 'approve once'].includes(label) && !option.disabled;
        });
        const wrapperCallId = typeof data.toolCallId === 'string' && data.toolCallId.trim() ? data.toolCallId : null;
        if (requestedTool && (requestedTool !== 'michi_call_tool' || wrapperCallId)
            && isOneTimePagePermissionAllowed(requestedTool, innerPageTool)
            && allowOption?.optionId && Number.isInteger(data.requestId)) {
          record.events.push({ event: 'permission_granted_once', tool: requestedTool,
            ...(innerPageTool ? { wrappedTool: innerPageTool } : {}),
            ...(requestedTool === 'michi_call_tool' ? { toolCallId: wrapperCallId,
              inputJson: sanitize(data.detail ?? data.inputJson ?? data.input ?? '') } : {}),
            decision: allowOption.name ?? allowOption.label, requestId: data.requestId, turnId });
          activeTurn.permissions.push({ requestId: data.requestId, tool: requestedTool,
            ...(innerPageTool ? { wrappedTool: innerPageTool } : {}), result: 'granted_once' });
          try {
            await post(`${apiBase}/chats/${encodeURIComponent(node)}/permission-response`, {
              requestId: data.requestId, optionId: allowOption.optionId,
            });
          } catch (error) {
            if (error?.status === 409 && error.responseText === '{"error":"Permission request is no longer pending"}') {
              record.events.push({ event: 'permission_already_resolved', tool: requestedTool,
                requestId: data.requestId, turnId });
              activeTurn.permissions.at(-1).result = 'already_resolved';
            } else {
              activeTurn.error = sanitize(error instanceof Error ? error.message : String(error));
              throw error;
            }
          }
        } else {
          attention = event;
          record.events.push({ event: 'permission_request', summary: {
            title: sanitize(data.title ?? ''), tool: requestedTool,
            ...(requestedTool === 'michi_call_tool' ? { wrappedTool: innerPageTool } : {}),
            options: (data.options ?? []).map((option) => option.name ?? option.label ?? ''),
            decision: 'not approved; outside the exact one-time Pages tool allowlist',
          } });
          await post(`${apiBase}/chats/${encodeURIComponent(node)}/cancel`, { turnId });
        }
      }
      if (event === 'user_input_request') {
        attention = event;
        record.events.push({ event, summary: { questionCount: (data.questions ?? []).length } });
        await post(`${apiBase}/chats/${encodeURIComponent(node)}/cancel`, { turnId });
      }
      if (event === 'error') record.events.push({ event, message: sanitize(data.message ?? ''), code: data.code ?? null });
      if (event === 'done' || event === 'error') {
        turnTerminated = true;
        activeTurn.terminal = event;
        record.events.push({ event, turnId: data.turnId, assistantId: data.assistantId, stopReason: data.stopReason, code: data.code });
      }
    }
    if (attention && collected.some((item) => item.event === 'tool_call_update' && /cancel|stop/i.test(item.status ?? ''))) break;
  }
  streamedChat = false;
  const summary = { requestedTurnId: turnId,
    turnId: record.turnEnvelope?.turnId ?? null, assistantId: record.turnEnvelope?.assistantId ?? null,
    toolEventCount: collected.length, toolCalls: collected.map(summarizeToolCall),
    terminal: activeTurn.terminal === 'pending' ? 'stream_closed' : activeTurn.terminal };
  activeTurn.summary = summary;
  record.turnTrace ??= [];
  record.turnTrace.push(activeTurn);
  if (record.turnTrace.length > 12) record.turnTrace.shift();
  record.activeTurn = null;
  return { attention, summary };
}

function summarizeToolCall(item) {
  return { title: item.title, status: item.status,
    ...(item.toolCallId ? { toolCallId: item.toolCallId } : {}),
    ...(item.turnId ? { turnId: item.turnId } : {}),
    ...(item.nativeTool ? { nativeTool: item.nativeTool } : {}),
    ...(item.inputJson ? { inputJson: item.inputJson } : {}) };
}

function permissionToolName(value) {
  const text = String(value).trim().replace(/^Running:\s*/i, '').toLowerCase().replace(/[?!.]+$/g, '');
  return [...oneTimePageTools].find((tool) => text === tool || text.endsWith(`/${tool}`) || text.endsWith(`____${tool}`)
    || text.endsWith(` ${tool}`)) ?? null;
}

function summarizeChanges(changes) {
  return changes.map((change) => ({ id: change.id, op: change.op, proposalState: change.proposalState,
    applicationState: change.applicationState, target: change.target,
    source: change.source ? { kind: change.source.kind, nodeId: change.source.nodeId,
      turnId: change.source.turnId, assistantId: change.source.assistantId } : null }));
}
function riskBlockFor(blocks) {
  const index = blocks.findIndex((block) => block.type === 'heading' && block.text === 'Risks');
  const candidate = blocks[index + 1];
  if (index < 0 || candidate?.type !== 'markdown') throw new Error('Release template did not include the expected Risks markdown block.');
  return candidate;
}
function boundOutput(value) {
  return value && typeof value === 'object' ? {
    michiPageWrite: value.michiPageWrite ?? null,
    result: value.result ? { resource: value.result.resource, revision: value.result.revision,
      applied: (value.result.applied ?? []).map((change) => ({ id: change.id, op: change.op, target: change.target, source: change.source })),
      proposed: (value.result.proposed ?? []).map((change) => ({ id: change.id, op: change.op, target: change.target, source: change.source })),
      rejected: value.result.rejected } : undefined,
    component: value.component ? { id: value.component.id, name: value.component.name,
      activeVersion: value.component.activeVersion, libraryRevision: value.component.libraryRevision } : undefined,
    version: value.version ? { componentId: value.version.componentId, version: value.version.version } : undefined,
  } : value;
}
function sanitize(value) {
  return String(value ?? '').replace(/(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|AKIA[0-9A-Z]{16})/g, '[redacted]').slice(0, 4000);
}
async function reservePort() {
  const net = await import('node:net');
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.once('error', reject).listen(0, '127.0.0.1', resolve));
  const value = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return value;
}
async function waitReady(base, childProcess) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (childProcess.exitCode !== null) return false;
    try { const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) }); if (response.ok) return true; } catch { /* booting */ }
    await delay(250);
  }
  return false;
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}: ${sanitize(await response.text())}`);
  return response.json();
}
async function captureFailureSnapshot(apiBase, ids) {
  if (!ids?.pageId || !ids?.databaseId) return null;
  const [page, database, changes, childPages] = await Promise.all([
    json(`${apiBase}/pages/${encodeURIComponent(ids.pageId)}`),
    json(`${apiBase}/databases/${encodeURIComponent(ids.databaseId)}`),
    json(`${apiBase}/pages/${encodeURIComponent(ids.pageId)}/changes?limit=100`),
    json(`${apiBase}/workspaces/${encodeURIComponent(ids.workspaceId)}/pages?parentId=${encodeURIComponent(ids.pageId)}`),
  ]);
  const progress = page.blocks.find((block) => block.type === 'callout' && block.title === 'Progress');
  const risk = page.blocks.find((block) => block.id === record.seed?.protectedRiskBlockId);
  const row = database.rows.find((item) => item.id === record.seed?.checklistRowId);
  return { page: { id: page.id, revision: page.revision, viewVersion: page.viewVersion,
      progress: progress?.text, risks: risk?.text, componentBlockCount: page.blocks.filter((block) => block.type === 'component').length },
    database: { id: database.id, revision: database.revision,
      row: row ? { id: row.id, rev: row.rev, values: row.values, editedColumnIds: Object.keys(row.edited) } : null,
      viewCount: database.views.length },
    pageChanges: summarizeChanges(changes.changes ?? []),
    createdChildren: (childPages.items ?? []).map((item) => ({ id: item.id, title: item.title, parentId: item.parentId })) };
}
async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) {
    const responseText = sanitize(await response.text());
    const error = new Error(`HTTP ${response.status} for ${new URL(url).pathname}: ${responseText}`);
    error.status = response.status;
    error.responseText = responseText;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}
function waitChild(proc, timeoutMs) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return Promise.race([new Promise((resolve) => proc.once('exit', resolve)), delay(timeoutMs).then(() => proc.kill('SIGKILL'))]);
}
