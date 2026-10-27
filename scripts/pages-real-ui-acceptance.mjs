#!/usr/bin/env node

/**
 * Real-backend browser acceptance for native Pages/Spaces. Uses fresh backend
 * data/config/log directories and a loopback-only backend + Vite renderer.
 * No API routes are mocked and no model/runtime turn is invoked.
 *
 * Run after shared/build readiness:
 *   node scripts/pages-real-ui-acceptance.mjs
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { capabilitiesForHost, capabilityReadHostSucceeded, isExpectedDeletedComponentRead, isExpectedDisabledComponent404, oldCapabilityCallsAfterOwnerReplacement, recordMintedComponentCapability } from './pages-real-ui-capability-evidence.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'michi-pages-ui-'));
const data = path.join(temp, 'data');
const config = path.join(temp, 'config');
const logs = path.join(temp, 'logs');
const workspaceCwd = path.join(temp, 'workspace');
await Promise.all([mkdir(data), mkdir(config), mkdir(logs), mkdir(workspaceCwd)]);

async function freePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve loopback port');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

const backendPort = await freePort();
const frontendPort = await freePort();
const backendApi = `http://127.0.0.1:${backendPort}/api`;
const children = [];
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const evidence = { runId, startedAt: new Date().toISOString(), isolation: 'fresh disposable SQLite, config, logs, workspace cwd', backendApi, frontendUrl: `http://127.0.0.1:${frontendPort}`, checks: {}, browserApiErrors: [], pageErrors: [], expectedDisabledWindows: [] };
let browser;
let beforeAskRequests;
let chatMessageRequests = [];
const componentCapabilityOwners = new Map();
const requestStartTimes = new WeakMap();

function exactNotFound(entry, message) {
  if (entry.status !== 404) return false;
  try {
    const payload = JSON.parse(entry.responseBody ?? '');
    return payload.error?.code === 'not_found' && payload.error?.message === message;
  } catch { return false; }
}

function rememberRequestStart(request) {
  try {
    const startTime = request.timing().startTime;
    if (Number.isFinite(startTime) && startTime > 0) { requestStartTimes.set(request, startTime); return; }
  } catch { /* use the request event timestamp */ }
  requestStartTimes.set(request, Date.now());
}

function requestStartedAt(request) {
  if (requestStartTimes.has(request)) return requestStartTimes.get(request);
  try {
    const startTime = request.timing().startTime;
    if (Number.isFinite(startTime) && startTime > 0) return startTime;
  } catch { /* timing is unavailable for this request */ }
  return Date.now();
}

function start(command, args, options) {
  const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    evidence.lastServerOutput = `${evidence.lastServerOutput ?? ''}${chunk}`.slice(-10_000);
  });
  children.push(child);
  return child;
}

async function waitFor(url, child, parseJson = true) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited before readiness: ${evidence.lastServerOutput ?? ''}`);
    try {
      const response = await fetch(url);
      if (response.ok) return parseJson ? await response.json() : true;
    } catch { /* starting */ }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}: ${evidence.lastServerOutput ?? ''}`);
}

async function api(method, route, body) {
  const response = await fetch(`${backendApi}${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} -> ${response.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

async function waitForComponentState(workspaceId, componentId, predicate, label) {
  const deadline = Date.now() + 20_000;
  let latest;
  while (Date.now() < deadline) {
    const library = await api('GET', `/workspaces/${encodeURIComponent(workspaceId)}/components`);
    latest = library.items.find((item) => item.id === componentId);
    if (latest && predicate(latest)) return latest;
    await delay(150);
  }
  throw new Error(`${label} did not reach the expected state: ${JSON.stringify(latest)}`);
}

async function waitForPageComponentBlock(pageId, componentId) {
  const deadline = Date.now() + 20_000;
  let latest = null;
  while (Date.now() < deadline) {
    const page = await api('GET', `/pages/${encodeURIComponent(pageId)}`);
    latest = page.blocks?.find((block) => block.type === 'component' && block.componentId === componentId) ?? null;
    if (latest) return latest;
    await delay(150);
  }
  throw new Error(`Inserted component block did not reach the persisted page: ${JSON.stringify(latest)}`);
}

try {
  const evidenceDir = path.join(root, 'docs/superpowers/plans');
  await mkdir(evidenceDir, { recursive: true });
  const useBundle = process.env.MICHI_PAGES_ACCEPTANCE_USE_BUNDLE === '1';
  const backendCommand = useBundle
    ? [path.join(root, 'backend/dist/server.js')]
    : ['--require', 'ts-node/register', 'src/server.ts'];
  evidence.backendMode = useBundle ? 'fresh backend bundle' : 'ts-node source';
  const backend = start(process.execPath, backendCommand, {
    cwd: path.join(root, 'backend'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(backendPort), MICHI_RENDERER_URL: `http://127.0.0.1:${frontendPort}`, MICHI_DATA_DIR: data, MICHI_CONFIG_DIR: config, MICHI_LOG_DIR: logs, MICHI_DEFAULT_CWD: workspaceCwd },
  });
  const vite = start(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    cwd: path.join(root, 'frontend'),
    env: { ...process.env, VITE_API_URL: backendApi },
  });
  const [health] = await Promise.all([waitFor(`${backendApi}/health`, backend), waitFor(`http://127.0.0.1:${frontendPort}`, vite, false)]);
  evidence.backendHealth = { status: health.status, serverId: health.serverId };
  const auth = await api('GET', '/auth-config');
  if (auth.requireAuth) throw new Error('Disposable backend unexpectedly requires a session; refusing to bypass login.');
  const workspaceId = `pages-ui-${randomUUID()}`;
  await api('PUT', `/workspaces/${encodeURIComponent(workspaceId)}`, { name: 'Pages live acceptance', cwd: workspaceCwd, created_at: Date.now() });
  const workspaceResponse = await api('GET', '/workspaces');
  const listedWorkspaces = Array.isArray(workspaceResponse) ? workspaceResponse : workspaceResponse.workspaces ?? [];
  const workspace = listedWorkspaces.find((item) => item.id === workspaceId && item.name === 'Pages live acceptance');
  if (!workspace) throw new Error(`Seeded workspace was absent from backend readback: ${JSON.stringify(workspaceResponse).slice(0, 1000)}`);
  evidence.workspaceId = workspace.id;
  evidence.checks.disposableWorkspacePersisted = true;

  const require = createRequire(import.meta.url);
  const { chromium } = require('@playwright/test');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  chatMessageRequests = [];
  const pendingApiBodyReads = [];
  evidence.dialogs = [];
  evidence.uiSteps = [];
  const markUiStep = (name, detail = {}) => evidence.uiSteps.push({ name, at: Date.now(), ...detail });
  page.on('pageerror', (error) => {
    if (error.message.includes("document is sandboxed and lacks the 'allow-same-origin' flag")) {
      evidence.sandboxLocalStorageErrors = (evidence.sandboxLocalStorageErrors ?? 0) + 1;
      return;
    }
    evidence.pageErrors.push(error.message);
  });
  page.on('request', (request) => {
    rememberRequestStart(request);
    if (request.method() === 'POST' && /\/api\/(?:backend-connections\/[^/]+\/proxy\/)?chats\/[^/]+\/message(?:\?|$)/.test(request.url())) chatMessageRequests.push(request.url());
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/component-capabilities')) {
      const request = response.request();
      evidence.componentCapabilityTraffic ??= [];
      const capabilityEvent = { at: Date.now(), requestStartedAt: requestStartedAt(request), method: request.method(), path: new URL(response.url()).pathname, status: response.status(), requestBody: request.postData() };
      evidence.componentCapabilityTraffic.push(capabilityEvent);
      if (request.method() === 'POST' && new URL(response.url()).pathname === '/api/component-capabilities' && response.status() === 201) {
        pendingApiBodyReads.push(response.text().then((body) => recordMintedComponentCapability(componentCapabilityOwners, capabilityEvent, request, JSON.parse(body), 'first', capabilityEvent.at)).catch(() => undefined));
      }
    }
    if (response.url().includes('/api/') && response.status() >= 400) {
      const request = response.request();
      const record = { at: Date.now(), requestStartedAt: requestStartedAt(request), method: request.method(), path: new URL(response.url()).pathname, status: response.status(), requestBody: request.postData() };
      pendingApiBodyReads.push(response.text().then((body) => evidence.browserApiErrors.push({ ...record, responseBody: body.slice(0, 1000) })).catch(() => evidence.browserApiErrors.push({ ...record, responseBody: '(response body unavailable)' })));
    }
  });

  await page.goto(evidence.frontendUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText('Pages live acceptance', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 });

  await page.getByRole('button', { name: 'Spaces', exact: true }).click();
  await page.getByRole('heading', { name: 'Spaces', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '＋ New Space' }).first().click();
  const create = page.locator('.spaces-modal');
  await create.getByLabel('Name').fill('Launch plan');
  await create.getByLabel('Starting point').selectOption('release');
  await create.getByRole('button', { name: 'Create Space' }).click();
  const space = page.locator('main.space-view');
  await space.locator('.space-view-title-row').getByRole('heading', { name: 'Launch plan', exact: true }).waitFor({ state: 'visible' });
  await space.getByRole('heading', { name: 'Risks', exact: true }).waitFor({ state: 'visible' });
  const pageIndex = await api('GET', `/workspaces/${encodeURIComponent(workspace.id)}/pages`);
  const nativePage = pageIndex.items?.find((item) => item.title === 'Launch plan');
  if (!nativePage) throw new Error('Space created in UI was absent from the live Pages API.');
  evidence.pageId = nativePage.id;
  evidence.checks.spaceCreatedOpenedAndPersisted = true;

  page.once('dialog', (dialog) => dialog.accept('Design notes'));
  await space.getByRole('button', { name: 'Add child page to Launch plan' }).click();
  await space.locator('.space-view-title-row').getByRole('heading', { name: 'Design notes', exact: true }).waitFor({ state: 'visible' });
  await space.getByRole('navigation', { name: 'Pages in this Space' }).getByRole('button', { name: 'Launch plan', exact: true }).click();

  const helper = page.getByRole('region', { name: 'Assistant for Launch plan' });
  await helper.getByText('Changes while you were away').waitFor({ state: 'visible', timeout: 20_000 });
  const helperPage = await api('GET', `/pages/${encodeURIComponent(nativePage.id)}`);
  if (!helperPage.helperNodeId) throw new Error('Opening the Space did not lazily provision its page helper.');
  evidence.helperNodeId = helperPage.helperNodeId;
  evidence.checks.helperProvisionedOnPageOpen = true;

  const initialPage = await api('GET', `/pages/${encodeURIComponent(nativePage.id)}`);
  evidence.initialPageBlockTypes = initialPage.blocks.map((block) => ({ id: block.id, type: block.type, ...(block.type === 'database-ref' ? { databaseId: block.databaseId, viewId: block.viewId } : {}) }));
  const risksHeadingIndex = initialPage.blocks.findIndex((block) => block.type === 'heading' && block.text === 'Risks');
  const riskParagraph = initialPage.blocks[risksHeadingIndex + 1];
  if (risksHeadingIndex < 0 || riskParagraph?.type !== 'markdown') throw new Error('Release Page has no editable Markdown block under Risks.');
  const risks = space.locator(`[data-block-id="${riskParagraph.id}"]`);
  await risks.hover();
  await risks.getByRole('button', { name: 'Edit' }).click();
  await risks.getByRole('textbox', { name: /^Edit / }).fill('Confirm the launch date by Friday.');
  await risks.getByRole('button', { name: 'Save' }).click();
  const changes = page.locator('.page-changes');
  await changes.waitFor({ state: 'visible', timeout: 10_000 });
  if (!(await changes.evaluate((element) => element.open))) await changes.locator('summary').click();
  const pageState = await api('GET', `/pages/${encodeURIComponent(nativePage.id)}`);
  const riskBlock = pageState.blocks.find((block) => block.id === riskParagraph.id && block.type === 'markdown' && block.text === 'Confirm the launch date by Friday.');
  if (!riskBlock) throw new Error('UI edit was not persisted in the backend Page.');
  evidence.checks.userEditPersisted = true;

  // Save and insert the library's default safe component through the visible
  // UI, then use its Ask button from the page pane. That path should place a
  // draft in the owner Page helper without sending a chat turn.
  await space.locator('.space-view-title-row').getByRole('button', { name: 'Components' }).click();
  const library = page.getByRole('region', { name: 'Native components' });
  await library.getByRole('button', { name: 'Save component' }).click();
  const componentSaveDeadline = Date.now() + 20_000;
  let uiComponentV1;
  while (Date.now() < componentSaveDeadline) {
    const componentListAfterV1 = await api('GET', `/workspaces/${encodeURIComponent(workspace.id)}/components`);
    uiComponentV1 = componentListAfterV1.items.find((item) => item.name === 'new-widget');
    if (uiComponentV1?.activeVersion === 1 && uiComponentV1.versions === 1) break;
    await delay(150);
  }
  if (!uiComponentV1 || uiComponentV1.activeVersion !== 1 || uiComponentV1.versions !== 1) throw new Error(`UI component v1 was not saved as the active library version: ${JSON.stringify(uiComponentV1)}`);
  const versionSelect = library.getByRole('combobox');
  const componentCodeEditor = library.getByLabel('Component code');
  const uiComponentCode = (await api('GET', `/components/${encodeURIComponent(uiComponentV1.id)}?workspaceId=${encodeURIComponent(workspace.id)}&version=1`)).code;
  if (typeof uiComponentCode !== 'string' || !uiComponentCode.trim()) throw new Error('Could not read the saved v1 component source before editing it.');
  await componentCodeEditor.fill(`${uiComponentCode}\n// Acceptance version two.\n`);
  await library.getByRole('button', { name: 'Save new version' }).click();
  let uiComponent = await waitForComponentState(workspace.id, uiComponentV1.id, (item) => item.activeVersion === 2 && item.versions === 2, 'UI component v2 save');
  await versionSelect.selectOption('1');
  await library.getByRole('button', { name: 'Rollback to v1' }).click();
  uiComponent = await waitForComponentState(workspace.id, uiComponentV1.id, (item) => item.activeVersion === 1, 'UI component rollback');
  await versionSelect.selectOption('2');
  await library.getByRole('button', { name: 'Activate v2' }).click();
  uiComponent = await waitForComponentState(workspace.id, uiComponentV1.id, (item) => item.activeVersion === 2, 'UI component activation');
  const initialDisableStartedAt = Date.now();
  await library.getByRole('button', { name: 'Disable', exact: true }).click();
  uiComponent = await waitForComponentState(workspace.id, uiComponentV1.id, (item) => !item.enabled, 'UI component disable');
  await library.getByRole('button', { name: 'Enable', exact: true }).click();
  uiComponent = await waitForComponentState(workspace.id, uiComponentV1.id, (item) => item.enabled, 'UI component enable');
  evidence.expectedDisabledWindows.push({ componentId: uiComponent.id, startedAt: initialDisableStartedAt, endedAt: Date.now(), host: null, source: 'initial-library-lifecycle' });
  evidence.uiComponentLifecycle = { componentId: uiComponent.id, versions: uiComponent.versions, activeVersion: uiComponent.activeVersion, enabled: uiComponent.enabled };
  evidence.checks.uiComponentVersionSaveRollbackActivateDisableEnable = true;
  await versionSelect.selectOption('1');
  const insertComponent = library.getByRole('button', { name: 'Insert selected component' });
  const saveDeadline = Date.now() + 20_000;
  while (!(await insertComponent.isEnabled()) && Date.now() < saveDeadline) await delay(100);
  if (!(await insertComponent.isEnabled())) throw new Error('Saved component did not become available for insertion.');
  page.on('dialog', async (dialog) => {
    evidence.dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept(dialog.type() === 'prompt' && dialog.message().toLowerCase().includes('properties') ? '{}' : '280');
  });
  await insertComponent.click();
  await page.locator('.page-component-frame').waitFor({ state: 'visible', timeout: 20_000 });
  await library.waitFor({ state: 'hidden', timeout: 10_000 });
  const insertedBlock = await waitForPageComponentBlock(nativePage.id, uiComponent.id);
  if (insertedBlock?.pinnedVersion !== 1) throw new Error(`The visible Insert action did not pin selected v1: ${JSON.stringify(insertedBlock)}`);
  evidence.uiComponentLifecycle.pinnedBlockVersion = insertedBlock.pinnedVersion;
  evidence.checks.uiComponentSelectedVersionPinnedOnInsert = true;
  evidence.checks.componentSavedAndInsertedInUi = true;

  // Open the same Space in a second browser page, disable its component from
  // that visible library, and verify the already-mounted first window polls
  // into a fallback and recovers after re-enable.
  const beforeLifecycleMessages = chatMessageRequests.length;
  const secondPage = await context.newPage();
  await secondPage.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  secondPage.on('pageerror', (error) => {
    if (error.message.includes("document is sandboxed and lacks the 'allow-same-origin' flag")) {
      evidence.sandboxLocalStorageErrors = (evidence.sandboxLocalStorageErrors ?? 0) + 1;
      return;
    }
    evidence.pageErrors.push(error.message);
  });
  secondPage.on('request', (request) => {
    rememberRequestStart(request);
    if (request.method() === 'POST' && /\/api\/(?:backend-connections\/[^/]+\/proxy\/)?chats\/[^/]+\/message(?:\?|$)/.test(request.url())) chatMessageRequests.push(request.url());
  });
  secondPage.on('dialog', async (dialog) => {
    evidence.dialogs.push({ type: dialog.type(), message: dialog.message(), page: 'second' });
    await dialog.accept(dialog.type() === 'prompt' && dialog.message().toLowerCase().includes('properties') ? '{}' : '280');
  });
  secondPage.on('response', (response) => {
    const currentPath = new URL(response.url()).pathname;
    if (currentPath.includes('/components') || currentPath.includes('/component-capabilities')) {
      evidence.secondPageComponentTraffic ??= [];
      evidence.secondPageComponentTraffic.push({ at: Date.now(), method: response.request().method(), path: currentPath.replace(/\/component-capabilities\/[^/]+$/, '/component-capabilities/:capability'), status: response.status() });
    }
    if (response.request().method() === 'DELETE' && response.status() >= 200 && response.status() < 300
      && currentPath === `/api/components/${encodeURIComponent(evidence.brokenSourceFixture?.componentId ?? '')}`) {
      evidence.brokenSourceDeletedAt = Date.now();
      evidence.brokenSourceDeleteResponse = { method: response.request().method(), path: currentPath, status: response.status(), at: evidence.brokenSourceDeletedAt };
    }
    if (response.url().includes('/api/component-capabilities')) {
      const request = response.request();
      evidence.componentCapabilityTraffic ??= [];
      const capabilityEvent = { at: Date.now(), requestStartedAt: requestStartedAt(request), method: request.method(), path: new URL(response.url()).pathname, status: response.status(), requestBody: request.postData() };
      evidence.componentCapabilityTraffic.push(capabilityEvent);
      if (request.method() === 'POST' && new URL(response.url()).pathname === '/api/component-capabilities' && response.status() === 201) {
        pendingApiBodyReads.push(response.text().then((body) => recordMintedComponentCapability(componentCapabilityOwners, capabilityEvent, request, JSON.parse(body), 'second', capabilityEvent.at)).catch(() => undefined));
      }
    }
    if (response.url().includes('/api/') && response.status() >= 400) {
      const request = response.request();
      const record = { at: Date.now(), requestStartedAt: requestStartedAt(request), method: request.method(), path: new URL(response.url()).pathname, status: response.status(), requestBody: request.postData() };
      pendingApiBodyReads.push(response.text().then((body) => evidence.browserApiErrors.push({ ...record, responseBody: body.slice(0, 1000) })).catch(() => evidence.browserApiErrors.push({ ...record, responseBody: '(response body unavailable)' })));
    }
  });
  await secondPage.goto(evidence.frontendUrl, { waitUntil: 'domcontentloaded' });
  markUiStep('second-page-domcontentloaded', { url: secondPage.url() });
  await secondPage.getByText('Pages live acceptance', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 });
  await secondPage.getByRole('button', { name: 'Spaces', exact: true }).click();
  await secondPage.getByRole('heading', { name: 'Spaces', exact: true }).waitFor({ state: 'visible' });
  await secondPage.getByRole('button', { name: 'Launch plan', exact: true }).click();
  markUiStep('second-page-opened-space', { url: secondPage.url() });
  const secondSpace = secondPage.locator('main.space-view');
  await secondSpace.locator('.space-view-title-row').getByRole('heading', { name: 'Launch plan', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await secondSpace.locator('.space-view-title-row').getByRole('button', { name: 'Components' }).click();
  const secondLibrary = secondPage.getByRole('region', { name: 'Native components' });
  markUiStep('second-page-library-opened');
  await secondLibrary.getByRole('button').filter({ hasText: 'new-widget' }).click();
  markUiStep('second-page-component-selected', { buttons: await secondLibrary.locator('button').allTextContents() });
  const capabilityHost = { kind: 'page_block', pageId: nativePage.id, blockId: insertedBlock.id };
  const oldTokensByPage = new Map();
  for (const ownerPage of ['first', 'second']) {
    const oldTokenCaptureDeadline = Date.now() + 15_000;
    while (!capabilitiesForHost(componentCapabilityOwners, uiComponent.id, capabilityHost, ownerPage).length && Date.now() < oldTokenCaptureDeadline) {
      await Promise.allSettled(pendingApiBodyReads);
      await delay(100);
    }
    const pageTokens = new Set(capabilitiesForHost(componentCapabilityOwners, uiComponent.id, capabilityHost, ownerPage).map(([token]) => token));
    if (!pageTokens.size) throw new Error(`The mounted page component did not mint a capability in the ${ownerPage} page before the disable test.`);
    oldTokensByPage.set(ownerPage, pageTokens);
  }
  const oldUiCapabilityTokens = new Set([...oldTokensByPage.values()].flatMap((tokens) => [...tokens]));
  const disableStartedAt = Date.now();
  await secondLibrary.getByRole('button', { name: 'Disable', exact: true }).click();
  markUiStep('second-page-disable-clicked');
  await waitForComponentState(workspace.id, uiComponent.id, (item) => !item.enabled, 'second-window component disable');
  const firstHost = page.locator(`.page-component-host[data-component-id="${uiComponent.id}"][data-component-version="1"]`);
  const firstWindowDisabledFallback = page.locator('.page-component-fallback').filter({ hasText: 'Component is disabled' });
  await firstWindowDisabledFallback.waitFor({ state: 'visible', timeout: 18_000 });
  const secondDisabledWindow = { componentId: uiComponent.id, startedAt: disableStartedAt, endedAt: null, host: capabilityHost, source: 'second-window-library-lifecycle' };
  evidence.expectedDisabledWindows.push(secondDisabledWindow);
  evidence.expectedDisabledWindow = secondDisabledWindow;
  evidence.checks.secondWindowDisablePropagatesToMountedFallback = true;
  await secondLibrary.getByRole('button', { name: 'Enable', exact: true }).click();
  await waitForComponentState(workspace.id, uiComponent.id, (item) => item.enabled, 'second-window component enable');
  secondDisabledWindow.endedAt = Date.now();
  await firstHost.waitFor({ state: 'visible', timeout: 18_000 });
  const replacementReadDeadline = Date.now() + 20_000;
  const capabilityRecoveryByPage = new Map();
  while (Date.now() < replacementReadDeadline && capabilityRecoveryByPage.size < oldTokensByPage.size) {
    await Promise.allSettled(pendingApiBodyReads);
    for (const [ownerPage, oldTokens] of oldTokensByPage) {
      if (capabilityRecoveryByPage.has(ownerPage)) continue;
      const replacement = capabilitiesForHost(componentCapabilityOwners, uiComponent.id, capabilityHost, ownerPage)
        .find(([token]) => !oldTokens.has(token) && capabilityReadHostSucceeded(evidence.componentCapabilityTraffic ?? [], token));
      if (replacement) {
        capabilityRecoveryByPage.set(ownerPage, { token: replacement[0], issuedAt: replacement[1].issuedAt, componentId: replacement[1].componentId });
      }
    }
    if (capabilityRecoveryByPage.size < oldTokensByPage.size) await delay(100);
  }
  if (capabilityRecoveryByPage.size !== oldTokensByPage.size) throw new Error(`The re-enabled page block did not mint a replacement capability with a successful read.host in every page context: ${JSON.stringify([...capabilityRecoveryByPage.keys()])}`);
  // Observe one full host refresh interval so a stale timer cannot hide a
  // post-renewal call behind a short quiet window.
  await delay(11_000);
  const postRenewalOldCapabilityCalls = oldCapabilityCallsAfterOwnerReplacement(
    evidence.componentCapabilityTraffic ?? [],
    componentCapabilityOwners,
    oldUiCapabilityTokens,
    Object.fromEntries(capabilityRecoveryByPage),
  );
  evidence.componentCapabilityRecovery = { componentId: uiComponent.id, replacements: Object.fromEntries(capabilityRecoveryByPage), replacementReadHostSucceeded: true, oldCapabilityCallsAfterReplacement: postRenewalOldCapabilityCalls.length };
  if (postRenewalOldCapabilityCalls.length) throw new Error(`The page block continued calling a revoked capability after replacement (${postRenewalOldCapabilityCalls.length} calls).`);
  evidence.checks.componentCapabilityRenewedAfterRevocation = true;
  evidence.checks.secondWindowEnableRestoresPinnedHost = true;

  // Exercise the real failure-repair path with a disposable source created,
  // inserted and deleted through the visible component library.
  await secondLibrary.getByRole('button', { name: '＋ New component' }).click();
  await secondLibrary.getByLabel('Name').fill('broken-widget');
  await secondLibrary.getByLabel('Description').fill('Disposable broken-source repair acceptance fixture.');
  await secondLibrary.getByLabel('Component code').fill('throw new Error("BROKEN_WIDGET_FAILURE acceptance marker");');
  await secondLibrary.getByRole('button', { name: 'Save component' }).click();
  const brokenSaveDeadline = Date.now() + 20_000;
  let brokenComponent;
  while (Date.now() < brokenSaveDeadline) {
    const componentList = await api('GET', `/workspaces/${encodeURIComponent(workspace.id)}/components`);
    brokenComponent = componentList.items.find((item) => item.name === 'broken-widget');
    if (brokenComponent?.activeVersion === 1 && brokenComponent.versions === 1) break;
    await delay(150);
  }
  if (!brokenComponent || brokenComponent.activeVersion !== 1) throw new Error(`Broken-source UI fixture was not saved: ${JSON.stringify(brokenComponent)}`);
  const brokenInsert = secondLibrary.getByRole('button', { name: 'Insert selected component' });
  const brokenInsertDeadline = Date.now() + 10_000;
  while (!(await brokenInsert.isEnabled()) && Date.now() < brokenInsertDeadline) await delay(100);
  if (!(await brokenInsert.isEnabled())) throw new Error('Broken-source fixture did not become available for UI insertion.');
  await brokenInsert.click();
  const brokenBlock = await waitForPageComponentBlock(nativePage.id, brokenComponent.id);
  evidence.brokenSourceFixture = { componentId: brokenComponent.id, blockId: brokenBlock.id, source: 'visible component library' };
  await secondSpace.getByRole('button', { name: 'Open beside chat' }).click();
  const brokenFrame = secondPage.locator(`.page-component-frame[aria-label="broken-widget component"]`);
  await brokenFrame.getByRole('alert').filter({ hasText: 'BROKEN_WIDGET_FAILURE acceptance marker' }).waitFor({ state: 'visible', timeout: 20_000 });
  const beforeBrokenAskRequests = chatMessageRequests.length;
  await secondPage.evaluate(() => {
    window.__pagesAcceptanceBrokenDraftEvents = [];
    window.addEventListener('michi:page-helper-draft', (event) => window.__pagesAcceptanceBrokenDraftEvents.push(event.detail));
  });
  await brokenFrame.getByRole('button', { name: 'Ask assistant to fix' }).click();
  await secondPage.waitForFunction(() => window.__pagesAcceptanceBrokenDraftEvents?.length > 0, null, { timeout: 10_000 });
  await secondPage.waitForFunction(() => [...document.querySelectorAll('[contenteditable="true"]')].some((element) => element.textContent?.includes('BROKEN_WIDGET_FAILURE acceptance marker') && element.textContent?.includes('Please help fix it.')), null, { timeout: 20_000 });
  evidence.brokenSourceRepairDraft = await secondPage.evaluate(() => ({
    events: window.__pagesAcceptanceBrokenDraftEvents,
    editors: [...document.querySelectorAll('[contenteditable="true"]')].map((element) => ({ text: element.textContent, visible: Boolean(element.offsetWidth || element.offsetHeight) })),
  }));
  if (chatMessageRequests.length !== beforeBrokenAskRequests) throw new Error('Ask assistant to fix submitted a chat message without user submission.');
  evidence.checks.brokenSourceAskFixDraftVisibleWithoutSending = true;

  await secondSpace.locator('.space-view-title-row').getByRole('button', { name: 'Components' }).click();
  const brokenLibrary = secondPage.getByRole('region', { name: 'Native components' });
  await brokenLibrary.getByRole('button', { name: 'broken-widget' }).click();
  await brokenLibrary.getByRole('button', { name: 'Delete', exact: true }).click();
  const deletedFixtureDeadline = Date.now() + 20_000;
  let deletedFixtureStillPresent = true;
  while (Date.now() < deletedFixtureDeadline) {
    const componentList = await api('GET', `/workspaces/${encodeURIComponent(workspace.id)}/components`);
    deletedFixtureStillPresent = componentList.items.some((item) => item.id === brokenComponent.id);
    if (!deletedFixtureStillPresent) break;
    await delay(150);
  }
  if (deletedFixtureStillPresent) throw new Error('Visible component library did not delete the broken-source fixture.');
  const deleteCaptureDeadline = Date.now() + 5_000;
  const expectedDeletePath = `/api/components/${encodeURIComponent(brokenComponent.id)}`;
  while (evidence.brokenSourceDeleteResponse?.path !== expectedDeletePath && Date.now() < deleteCaptureDeadline) await delay(25);
  if (evidence.brokenSourceDeleteResponse?.method !== 'DELETE'
    || evidence.brokenSourceDeleteResponse.path !== expectedDeletePath
    || evidence.brokenSourceDeleteResponse.status < 200 || evidence.brokenSourceDeleteResponse.status >= 300) {
    throw new Error('Visible component library deletion was confirmed by the backend, but its matching successful DELETE response was not captured.');
  }
  await secondPage.getByRole('status').filter({ hasText: 'Component not found' }).waitFor({ state: 'visible', timeout: 20_000 });
  await secondSpace.getByRole('heading', { name: 'Risks', exact: true }).waitFor({ state: 'visible' });
  evidence.checks.brokenSourceDeletionFallsBackAndPageRemainsAvailable = true;
  evidence.brokenSourceFixture.deletedThroughVisibleLibrary = true;
  if (chatMessageRequests.length !== beforeLifecycleMessages) throw new Error('The version lifecycle checks unexpectedly submitted a chat message.');
  await page.bringToFront();

  const databaseIndex = await api('GET', `/workspaces/${encodeURIComponent(workspace.id)}/databases`);
  const database = databaseIndex.items.find((item) => item.title === 'Release checklist');
  if (!database) throw new Error('Release template database missing from live backend.');
  const taskColumn = database.columns.find((column) => column.name === 'Task');
  const row = database.rows[0];
  // Exercise the same saved database through its Table and Board renderings.
  const dbUi = page.locator(`[data-native-database][data-database-id="${database.id}"]`);
  await dbUi.waitFor({ state: 'visible', timeout: 20_000 });
  await dbUi.getByRole('button', { name: 'Add view' }).click();
  await page.getByRole('menuitem', { name: 'Table', exact: true }).click();
  await dbUi.getByRole('tab', { name: 'Table' }).click();
  const table = dbUi.getByRole('table', { name: 'Table' });
  const uiRow = table.locator(`[data-row-id="${row.id}"]`);
  await uiRow.locator('td').nth(1).dblclick();
  const taskEditor = table.getByRole('textbox', { name: 'Edit Task' });
  await taskEditor.fill('Complete smoke test');
  await taskEditor.press('Enter');
  await dbUi.getByRole('tab', { name: 'Board' }).click();
  await dbUi.getByText('Complete smoke test', { exact: true }).waitFor({ state: 'visible' });
  const databaseAfter = await api('GET', `/databases/${encodeURIComponent(database.id)}`);
  if (databaseAfter.rows[0]?.values?.[taskColumn.id] !== 'Complete smoke test') throw new Error('Table/Board row edit was not persisted.');
  evidence.checks.sharedTableBoardRowPersisted = true;

  // Save the exact Codex-generated component source into this disposable library,
  // then mount it as a custom view to exercise real sandbox data updates. The
  // component's prior source/version/hash is recorded as provider evidence by
  // the separate runtime gate; this browser host persists the source as a
  // user-seeded record because that runtime database is intentionally gone.
  const componentSourcePath = path.join(root, 'docs/superpowers/plans/pages-real-runtime-evidence/codex-release-risk-meter-v1.js');
  const componentCode = await readFile(componentSourcePath, 'utf8');
  evidence.componentSourceHash = createHash('sha256').update(componentCode).digest('hex');
  if (evidence.componentSourceHash !== 'cff1f2e728a64512d24a2f682a6ca4e67409c9d70109aed0c5a54d462f6972d9') throw new Error(`Generated component source hash changed: ${evidence.componentSourceHash}`);
  const componentLibrary = await api('GET', `/workspaces/${encodeURIComponent(workspace.id)}/components`);
  const riskComponentResult = await api('POST', `/workspaces/${encodeURIComponent(workspace.id)}/components`, {
    expectedLibraryRevision: componentLibrary.revision,
    input: {
      name: 'release-risk-meter',
      description: 'Summarizes checklist status and offers a protected task proposal',
      code: componentCode,
      propsSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false },
    },
  });
  const riskComponentId = riskComponentResult.component.id;
  evidence.browserComponentId = riskComponentId;
  evidence.componentSource = { provenance: 'Codex runtime gate saved and read back exact v1; copied into disposable UI backend as user-attributed source for renderer acceptance', runtimeComponentId: 'pc-8a666249-3f48-45a7-951b-0a476433619a', path: path.relative(root, componentSourcePath), version: 1, sha256: evidence.componentSourceHash };
  evidence.checks.providerSourceSavedInDisposableLibrary = true;
  const customView = {
    name: 'Risk meter',
    type: 'custom',
    config: { componentId: riskComponentId, pinnedVersion: 1, props: { title: 'Release risk summary' }, height: 300, filters: [], sorts: [], match: 'all' },
  };
  const viewEdit = await api('POST', `/databases/${encodeURIComponent(database.id)}/edits`, {
    revision: databaseAfter.revision,
    ops: [{ op: 'view.save', view: customView }],
  });
  evidence.databaseViewId = viewEdit.database?.views?.find((view) => view.name === 'Risk meter')?.id;
  if (!evidence.databaseViewId) throw new Error('Custom database view was not persisted by the live backend.');
  evidence.checks.customDatabaseViewPersisted = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await space.getByRole('heading', { name: 'Risks', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  const refreshedDbUi = page.locator(`[data-native-database][data-database-id="${database.id}"]`);
  await refreshedDbUi.getByRole('tab', { name: 'Risk meter' }).click();
  const riskFrame = page.frameLocator('iframe[title="release-risk-meter preview"]');
  await riskFrame.getByText('Release risk summary', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await riskFrame.getByText('Complete smoke test', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 });
  evidence.checks.generatedComponentRenderedWithLiveData = true;
  const beforeLiveUpdate = await api('GET', `/databases/${encodeURIComponent(database.id)}`);
  // Change the current database snapshot through the live API while the custom
  // view frame remains mounted. This user edit establishes ownership before the
  // component proposes its Task change, keeping the same row revision current.
  const liveRow = beforeLiveUpdate.rows.find((candidate) => candidate.id === row.id);
  if (!liveRow) throw new Error('The component target row disappeared before live-update verification.');
  const riskFrameElement = page.locator('iframe[title="release-risk-meter preview"]');
  const frameIdentity = `acceptance-${runId}`;
  await riskFrameElement.evaluate((element, identity) => {
    element.dataset.acceptanceIdentity = identity;
    element.dataset.acceptanceLoadCount = '0';
    element.addEventListener('load', () => { element.dataset.acceptanceLoadCount = String(Number(element.dataset.acceptanceLoadCount ?? '0') + 1); });
  }, frameIdentity);
  const liveUpdate = await api('POST', `/databases/${encodeURIComponent(database.id)}/edits`, {
    revision: beforeLiveUpdate.revision,
    ops: [{ op: 'row.update', id: liveRow.id, expectRev: liveRow.rev, values: { [taskColumn.id]: 'Updated without worker restart' } }],
  });
  if (liveUpdate.database?.rows?.find((candidate) => candidate.id === liveRow.id)?.values?.[taskColumn.id] !== 'Updated without worker restart') throw new Error('The live data update did not persist.');
  const riskFrameAfterUpdate = page.frameLocator('iframe[title="release-risk-meter preview"]');
  await riskFrameAfterUpdate.getByText(/Updated without worker restart/).waitFor({ state: 'visible', timeout: 20_000 });
  const frameAfterUpdate = await riskFrameElement.evaluate((element) => ({ identity: element.dataset.acceptanceIdentity, loads: element.dataset.acceptanceLoadCount }));
  if (frameAfterUpdate.identity !== frameIdentity || frameAfterUpdate.loads !== '0') throw new Error(`The component frame reloaded during a live data update: ${JSON.stringify(frameAfterUpdate)}`);
  evidence.liveUpdate = { task: 'Updated without worker restart', frameIdentity: frameAfterUpdate.identity, additionalFrameLoads: Number(frameAfterUpdate.loads), source: 'direct real-backend database edit while custom view remained selected' };
  evidence.checks.liveDataUpdatedWithoutFrameRestart = true;

  await riskFrameAfterUpdate.getByRole('button', { name: 'Propose task change' }).click();
  await riskFrameAfterUpdate.getByText('Proposal created for review. The proposed Task change was not applied.', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  const afterProtectedWrite = await api('GET', `/databases/${encodeURIComponent(database.id)}`);
  if (afterProtectedWrite.rows.find((candidate) => candidate.id === row.id)?.values?.[taskColumn.id] !== 'Updated without worker restart') throw new Error('Protected component write changed a human-owned row before review.');
  evidence.checks.protectedComponentWriteCreatedProposal = true;

  const databaseChanges = page.locator('.page-change-targets[aria-label="Changes to this database"]');
  const proposal = databaseChanges.locator('.page-change-card').filter({ hasText: 'Component · v1' });
  await proposal.waitFor({ state: 'visible', timeout: 20_000 });
  const proposalText = await proposal.innerText();
  if (!/component|release-risk-meter/i.test(proposalText)) throw new Error(`Proposal has no visible component attribution: ${proposalText.slice(0, 500)}`);
  evidence.proposalAttributionText = proposalText;
  await proposal.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.waitForFunction(async ({ apiBase, databaseId, rowId, columnId }) => {
    const response = await fetch(`${apiBase}/databases/${encodeURIComponent(databaseId)}`);
    if (!response.ok) return false;
    const snapshot = await response.json();
    return snapshot.rows?.find((item) => item.id === rowId)?.values?.[columnId] === 'Model-proposed acceptance task';
  }, { apiBase: backendApi, databaseId: database.id, rowId: row.id, columnId: taskColumn.id }, { timeout: 20_000 });
  evidence.checks.proposalAcceptedThroughUi = true;
  await proposal.getByRole('button', { name: 'Undo', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await proposal.getByRole('button', { name: 'Undo', exact: true }).click();
  await page.waitForFunction(async ({ apiBase, databaseId, rowId, columnId }) => {
    const response = await fetch(`${apiBase}/databases/${encodeURIComponent(databaseId)}`);
    if (!response.ok) return false;
    const snapshot = await response.json();
    return snapshot.rows?.find((item) => item.id === rowId)?.values?.[columnId] === 'Updated without worker restart';
  }, { apiBase: backendApi, databaseId: database.id, rowId: row.id, columnId: taskColumn.id }, { timeout: 20_000 });
  const afterUndo = await api('GET', `/databases/${encodeURIComponent(database.id)}`);
  if (afterUndo.rows.find((candidate) => candidate.id === row.id)?.values?.[taskColumn.id] !== 'Updated without worker restart') throw new Error('Proposal Undo did not restore the live human row value.');
  evidence.checks.proposalUndoRestoredHumanValue = true;
  await proposal.getByRole('button', { name: 'Redo', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  await proposal.getByRole('button', { name: 'Redo', exact: true }).click();
  await page.waitForFunction(async ({ apiBase, databaseId, rowId, columnId }) => {
    const response = await fetch(`${apiBase}/databases/${encodeURIComponent(databaseId)}`);
    if (!response.ok) return false;
    const snapshot = await response.json();
    return snapshot.rows?.find((item) => item.id === rowId)?.values?.[columnId] === 'Model-proposed acceptance task';
  }, { apiBase: backendApi, databaseId: database.id, rowId: row.id, columnId: taskColumn.id }, { timeout: 20_000 });
  const afterRedo = await api('GET', `/databases/${encodeURIComponent(database.id)}`);
  if (afterRedo.rows.find((candidate) => candidate.id === row.id)?.values?.[taskColumn.id] !== 'Model-proposed acceptance task') throw new Error('Proposal Redo did not restore the accepted value.');
  evidence.checks.proposalRedoRestoredAcceptedValue = true;

  await space.getByRole('button', { name: 'Open beside chat' }).click();
  await page.locator('[data-pane-width-mode]').waitFor({ state: 'visible' });
  await page.locator('.pane-entry-surface').filter({ hasText: 'Launch plan' }).waitFor({ state: 'visible' });
  evidence.checks.pagePaneOpened = true;
  beforeAskRequests = chatMessageRequests.length;
  const widgetFrame = page.frameLocator('iframe[title="new-widget preview"]');
  await page.evaluate(() => {
    window.__pagesAcceptanceDraftEvents = [];
    window.addEventListener('michi:page-helper-draft', (event) => {
      window.__pagesAcceptanceDraftEvents.push(event.detail);
    });
  });
  await widgetFrame.getByRole('button', { name: 'Ask about this' }).click();
  await page.waitForFunction(() => window.__pagesAcceptanceDraftEvents?.length > 0, null, { timeout: 10_000 });
  evidence.askDraftEvents = await page.evaluate(() => window.__pagesAcceptanceDraftEvents);
  await page.waitForFunction(() => [...document.querySelectorAll('[role="textbox"]')].some((element) => element.textContent?.includes('Tell me about Sample')), null, { timeout: 20_000 });
  evidence.askComposer = await page.evaluate(() => ({
    bodyText: document.body.innerText.slice(-3_000),
    editors: [...document.querySelectorAll('[contenteditable="true"]')].map((element) => ({ text: element.textContent, visible: Boolean(element.offsetWidth || element.offsetHeight) })),
  }));
  if (chatMessageRequests.length !== beforeAskRequests) throw new Error('The helper draft path sent a chat message without user submission.');
  evidence.checks.pagePaneAskCreatesHelperDraftWithoutSending = true;
  const screenshotPath = path.join(root, 'docs/superpowers/plans', `pages-real-ui-evidence-${runId}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  evidence.screenshotPath = path.relative(root, screenshotPath);

  const trash = await api('GET', `/workspaces/${encodeURIComponent(workspace.id)}/pages/trash`);
  evidence.trashBeforeDelete = trash.items?.length ?? 0;
  evidence.checks.trashEndpointReadable = true;
  await Promise.allSettled(pendingApiBodyReads);
  evidence.rawBrowserApiErrors = [...evidence.browserApiErrors];
  evidence.componentCapabilityOwners = [...componentCapabilityOwners].map(([token, owner]) => ({ token, ...owner }));
  const expectedLifecycleErrors = evidence.browserApiErrors.filter((entry) =>
    isExpectedDisabledComponent404(entry, uiComponent.id, evidence.expectedDisabledWindows, componentCapabilityOwners));
  if (expectedLifecycleErrors.length) {
    evidence.expectedLifecycle404s = expectedLifecycleErrors;
    evidence.browserApiErrors = evidence.browserApiErrors.filter((entry) => !expectedLifecycleErrors.includes(entry));
  }
  const expectedRecoveryRevocations = [];
  const recoveryTokensSeen = new Set();
  const replacementsByPage = evidence.componentCapabilityRecovery?.replacements ?? {};
  for (const entry of evidence.browserApiErrors) {
    if (!entry || typeof entry !== 'object' || entry.method !== 'POST' || !exactNotFound(entry, 'Component capability was revoked')) continue;
    const token = decodeURIComponent(entry.path.split('/').at(-1) ?? '');
    const owner = componentCapabilityOwners.get(token);
    const pageReplacementAt = owner && replacementsByPage[owner.page]?.issuedAt;
    const startedAt = entry.requestStartedAt ?? entry.at;
    const afterDisabled = startedAt > (evidence.expectedDisabledWindow?.endedAt ?? Number.POSITIVE_INFINITY);
    if (entry.path !== `/api/component-capabilities/${encodeURIComponent(token)}` || !afterDisabled
      || !owner || owner.componentId !== uiComponent.id || !oldUiCapabilityTokens.has(token)
      || typeof pageReplacementAt !== 'number' || startedAt > pageReplacementAt || recoveryTokensSeen.has(token)) continue;
    recoveryTokensSeen.add(token);
    expectedRecoveryRevocations.push(entry);
  }
  if (expectedRecoveryRevocations.length) {
    evidence.expectedRecoveryRevocations = expectedRecoveryRevocations;
    evidence.browserApiErrors = evidence.browserApiErrors.filter((entry) => !expectedRecoveryRevocations.includes(entry));
  }
  const expectedDeletedFixtureReads = evidence.browserApiErrors.filter((entry) =>
    isExpectedDeletedComponentRead(entry, evidence.brokenSourceFixture?.componentId, evidence.brokenSourceDeleteResponse));
  if (expectedDeletedFixtureReads.length) {
    evidence.expectedDeletedFixtureReads = expectedDeletedFixtureReads;
    evidence.browserApiErrors = evidence.browserApiErrors.filter((entry) => !expectedDeletedFixtureReads.includes(entry));
  }
  evidence.browserApiErrors = [...new Set(evidence.browserApiErrors)];
  evidence.result = Object.values(evidence.checks).every(Boolean) && evidence.browserApiErrors.length === 0 && evidence.pageErrors.length === 0 ? 'passed' : 'partial';
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
  evidence.result = 'failed_or_incomplete';
  if (beforeAskRequests !== undefined) {
    evidence.askChatMessageRequestsBefore = beforeAskRequests;
    evidence.askChatMessageRequestsAtFailure = chatMessageRequests.length;
  }
  try {
    if (browser) {
      const contexts = browser.contexts();
      if (contexts[0]) {
        evidence.failurePages = await Promise.all(contexts[0].pages().map(async (failedPage, index) => ({
          index,
          url: failedPage.url(),
          title: await failedPage.title().catch(() => ''),
          dom: await failedPage.evaluate(() => ({
            readyState: document.readyState,
            bodyText: document.body.innerText.slice(-8_000),
            visibleButtons: [...document.querySelectorAll('button')].filter((element) => element.offsetWidth || element.offsetHeight).slice(-80).map((element) => ({ text: element.innerText, disabled: element.disabled, ariaLabel: element.getAttribute('aria-label') })),
            mainText: [...document.querySelectorAll('main')].map((element) => element.innerText.slice(-4_000)),
          })).catch((cause) => ({ error: cause instanceof Error ? cause.message : String(cause) })),
        })));
      }
      if (contexts[0]?.pages()[0]) {
        const failedPage = contexts[0].pages()[0];
        evidence.failureDom = await failedPage.evaluate(() => ({
          title: document.title,
          bodyText: document.body.innerText.slice(-8_000),
          editors: [...document.querySelectorAll('[contenteditable="true"], textarea, input')].map((element) => ({
            tag: element.tagName,
            role: element.getAttribute('role'),
            ariaLabel: element.getAttribute('aria-label'),
            placeholder: element.getAttribute('placeholder'),
            text: element.textContent?.slice(0, 500),
            value: 'value' in element ? String(element.value).slice(0, 500) : undefined,
            visible: Boolean(element.offsetWidth || element.offsetHeight),
            className: typeof element.className === 'string' ? element.className : '',
          })),
          iframes: [...document.querySelectorAll('iframe')].map((element) => ({
            title: element.title,
            src: element.getAttribute('src'),
            visible: Boolean(element.offsetWidth || element.offsetHeight),
          })),
          paneText: [...document.querySelectorAll('.pane-entry-surface')].map((element) => element.textContent?.slice(0, 2_000)),
          pageHelperDraftEvents: window.__pagesAcceptanceDraftEvents ?? [],
          panes: [...document.querySelectorAll('.terminal-pane')].map((element) => ({
            nodeId: element.getAttribute('data-node-id'),
            text: element.innerText.slice(-1_000),
            editors: [...element.querySelectorAll('[role="textbox"], [contenteditable="true"]')].map((editor) => editor.textContent),
          })),
          helperPanels: [...document.querySelectorAll('.space-helper')].map((element) => ({
            label: element.getAttribute('aria-label'),
            text: element.innerText.slice(-2_000),
            nodeIds: [...element.querySelectorAll('[data-node-id]')].map((pane) => pane.getAttribute('data-node-id')),
          })),
        }));
        evidence.helperDraftDiagnostics = await failedPage.evaluate(async () => {
          const events = window.__pagesAcceptanceDraftEvents ?? [];
          const request = events.at(-1);
          let pendingRequests = null;
          let queueReadError = null;
          if (request) {
            try {
              const draftModule = await import('/src/state/pages/pageHelperDraft.ts');
              pendingRequests = draftModule.pendingPageHelperDrafts({
                backendConnectionId: request.backendConnectionId,
                workspaceId: request.workspaceId,
                pageId: request.pageId,
              });
            } catch (error) { queueReadError = error instanceof Error ? error.message : String(error); }
          }
          const typeName = (fiber) => {
            const type = fiber?.elementType ?? fiber?.type;
            return type?.displayName ?? type?.name ?? type?.type?.displayName ?? type?.type?.name ?? (typeof type === 'string' ? type : null);
          };
          const hookSummary = (fiber) => {
            const hooks = [];
            let hook = fiber?.memoizedState;
            for (let index = 0; hook && index < 80; index += 1, hook = hook.next) {
              const value = hook.memoizedState;
              if (value && typeof value === 'object' && !Array.isArray(value)) {
                hooks.push({ index, keys: Object.keys(value).slice(0, 24), nodeId: value.nodeId, composerDraft: value.composerDraft });
              } else if (typeof value === 'string' || typeof value === 'number' || value == null) hooks.push({ index, value });
            }
            return hooks;
          };
          const descendants = (fiber, limit = 120) => {
            const rows = [];
            const visit = (start) => {
              const stack = start ? [start] : [];
              while (stack.length && rows.length < limit) {
                const current = stack.pop();
                for (let sibling = current; sibling && rows.length < limit; sibling = sibling.sibling) {
                  rows.push(sibling);
                  if (sibling.child) stack.push(sibling.child);
                }
              }
            };
            visit(fiber?.child);
            return rows;
          };
          const ancestry = (element) => {
            const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactFiber$'));
            const rows = [];
            for (let fiber = key ? element[key] : null, depth = 0; fiber && depth < 30; fiber = fiber.return, depth += 1) {
              const name = typeName(fiber);
              if (name) rows.push({ name, props: Object.fromEntries(['nodeId', 'draftRequest', 'value', 'mentions', 'selectedPageContext'].filter((prop) => prop in (fiber.memoizedProps ?? {})).map((prop) => [prop, fiber.memoizedProps[prop]])), hooks: ['TPane', 'HelperPanel', 'MentionEditor'].includes(name) ? hookSummary(fiber) : undefined });
            }
            return rows;
          };
          return {
            event: request ?? null,
            pendingRequests,
            queueReadError,
            helperPanels: [...document.querySelectorAll('.space-helper')].map((element) => ({ label: element.getAttribute('aria-label'), ancestry: ancestry(element) })),
            panes: [...document.querySelectorAll('.terminal-pane')].map((element) => {
              const chain = ancestry(element);
              const key = Object.keys(element).find((candidate) => candidate.startsWith('__reactFiber$'));
              let paneFiber = key ? element[key] : null;
              while (paneFiber && typeName(paneFiber) !== 'TPane') paneFiber = paneFiber.return;
              const editorFibers = descendants(paneFiber).filter((fiber) => typeName(fiber) === 'MentionEditor');
              return {
                nodeId: element.getAttribute('data-node-id'),
                ancestry: chain,
                mentionEditors: editorFibers.map((fiber) => ({
                  props: { value: fiber.memoizedProps?.value, mentions: fiber.memoizedProps?.mentions },
                  hooks: hookSummary(fiber),
                  editorJson: (() => {
                    let hook = fiber.memoizedState;
                    for (let index = 0; hook && index < 80; index += 1, hook = hook.next) {
                      const value = hook.memoizedState;
                      if (value && typeof value.getJSON === 'function') return { destroyed: value.isDestroyed, json: value.isDestroyed ? null : value.getJSON() };
                      if (value?.current && typeof value.current.getJSON === 'function') return { destroyed: value.current.isDestroyed, json: value.current.isDestroyed ? null : value.current.getJSON() };
                    }
                    return null;
                  })(),
                })),
              };
            }),
            editors: [...document.querySelectorAll('.space-helper .ProseMirror')].map((element) => ({ text: element.textContent, ancestry: ancestry(element) })),
          };
        });
        evidence.failureFrames = await Promise.all(failedPage.frames().map(async (frame) => ({
          name: frame.name(),
          url: frame.url(),
          bodyText: await frame.locator('body').innerText().catch(() => ''),
        })));
        if (evidence.workspaceId) {
          try {
            const snapshot = await api('GET', `/workspaces/${encodeURIComponent(evidence.workspaceId)}`);
            const nodes = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
            evidence.failureWorkspaceNodes = nodes.map((node) => ({
              id: node.id,
              keys: Object.keys(node),
              pageId: node.pageId ?? node.page_id,
              composerDraft: node.composerDraft ?? node.composer_draft,
              messagesLoaded: node.messagesLoaded ?? node.messages_loaded,
              messageCount: Array.isArray(node.messages) ? node.messages.length : undefined,
            }));
          } catch (diagnosticError) {
            evidence.failureWorkspaceSnapshotError = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
          }
        }
        const screenshotPath = path.join(root, 'docs/superpowers/plans', `pages-real-ui-failure-${runId}.png`);
        await failedPage.screenshot({ path: screenshotPath, fullPage: false });
        evidence.failureScreenshotPath = path.relative(root, screenshotPath);
      }
    }
  } catch { /* retain original failure */ }
} finally {
  await browser?.close().catch(() => {});
  for (const child of children) child.kill('SIGTERM');
  for (const child of children) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  const evidenceDir = path.join(root, 'docs/superpowers/plans');
  await mkdir(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, `pages-real-ui-acceptance-${runId}.json`);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const bestPath = path.join(evidenceDir, 'pages-real-ui-acceptance.json');
  let prior = null;
  try { prior = JSON.parse(await readFile(bestPath, 'utf8')); } catch { /* first run */ }
  const currentCount = Object.values(evidence.checks).filter(Boolean).length;
  const priorCount = Object.values(prior?.checks ?? {}).filter(Boolean).length;
  if (!prior || currentCount > priorCount || (currentCount === priorCount && evidence.result === 'passed' && prior.result !== 'passed')) {
    evidence.evidencePath = path.relative(root, evidencePath);
    await writeFile(bestPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
  await rm(temp, { recursive: true, force: true });
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
}
