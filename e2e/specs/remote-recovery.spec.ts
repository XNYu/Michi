import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

const connection = { id: 'remote-c', name: 'build+', transport: 'ssh', sshHost: 'build+', remotePort: 4444, hasToken: true, createdAt: 1, updatedAt: 1 };
const localStatus = (available: boolean) => ({ runtime: 'mock', label: 'Local Mock', hasRequiredKey: available,
  capabilities: { modes: false, permissions: false, providerModels: false, reasoning: false, apiKeys: false, warmSessions: false },
  availableRuntimes: available ? [{ id: 'mock', label: 'Local Mock', available: true, requiresApiKey: false }] : [],
});
const clipboard = () => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as unknown as { copiedDiagnostic: string }).copiedDiagnostic = text; } } });
};

for (const entry of ['settings', 'workspace']) {
  test(`runtime warning diagnostics remain available in ${entry}`, async ({ page }) => {
    await page.addInitScript(clipboard);
    const sends: { path: string; body: unknown }[] = [];
    const diagnostic = { id: 'runtime-warning', host: 'build+', startedAt: '2026-10-16T12:00:00Z', severity: 'warning', stage: 'runtime', code: 'runtime_warning', message: 'Claude Code needs sign-in.', log: '[runtime] Claude authentication file missing', truncated: false };
    await installMockApi(page, { custom: async route => {
      const req = route.request(); const path = new URL(req.url()).pathname;
      if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [] } }); return true; }
      if (path === '/api/agent/status') { await route.fulfill({ json: localStatus(entry === 'workspace') }); return true; }
      if (path === '/api/backend-connections/connect-ssh') {
        await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'result', result: { kind: 'connected', connection, home: '/home/u', runtimes: ['claude'], runtimeWarnings: ['Claude Code needs sign-in.'], diagnostic } }) + '\n' }); return true;
      }
      if (path.endsWith('/directories')) { await route.fulfill({ json: { path: '/home/u', parent: '/home', entries: [] } }); return true; }
      if (path.endsWith('/proxy/workspaces/all')) { await route.fulfill({ json: { workspaces: [] } }); return true; }
      if (req.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(path)) sends.push({ path, body: req.postDataJSON() });
      return false;
    } });
    if (entry === 'workspace') {
      await page.goto('/');
      await page.getByRole('dialog', { name: 'New workspace' }).getByLabel('Backend connection').selectOption('__add_remote__');
    } else {
      await bootWithWorkspace(page);
      await page.getByText('Settings', { exact: true }).last().click();
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await settings.getByRole('button', { name: 'Connections', exact: true }).click();
      await settings.getByRole('button', { name: 'Connect remote', exact: true }).click();
    }
    const dialog = page.getByRole('dialog', { name: entry === 'workspace' ? 'New workspace' : 'Settings', exact: true });
    await dialog.getByLabel(/\S+ SSH host$/).fill('build+');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dialog.getByText('Claude Code needs sign-in.', { exact: true })).toBeVisible();
    if (entry === 'workspace') await expect(dialog.getByRole('button', { name: 'Use this folder' })).toBeVisible();
    await dialog.getByRole('button', { name: 'View logs' }).click();
    await expect(dialog.getByLabel('Connection log')).toHaveValue(/Warning: runtime_warning[\s\S]*authentication file missing/);
    await dialog.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(dialog.getByText('Diagnostics copied.')).toBeVisible();
    if (entry === 'workspace') {
      await dialog.getByRole('button', { name: 'Ask local agent' }).click();
      await expect(dialog).toBeHidden();
      await expect.poll(() => sends.length).toBe(1);
      expect(sends[0].path).toMatch(/^\/api\/chats\//);
      expect(JSON.stringify(sends[0].body)).toContain('The machine connected');
    } else {
      await expect(dialog.getByText('No ready local runtime. View or copy diagnostics below.')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Ask local agent' })).toHaveCount(0);
    }
  });
}

for (const hasLocalRuntime of [true, false]) {
  test(`background recovery shows persistent diagnostics and ${hasLocalRuntime ? 'local agent handoff' : 'copy fallback'}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 980, height: 940 });
    await page.addInitScript(clipboard);
    let online = false;
    let attempts = 0;
    const sends: { path: string; body: unknown }[] = [];
    const localWorkspace = { workspace: { id: 'local-ws', name: 'Local project', created_at: 1 }, nodes: [], trees: [], edges: [], messages: [], artifacts: [] };
    const remoteWorkspace = { ...localWorkspace, workspace: { id: 'remote-ws', name: 'Remote recovered', cwd: '/home/u/project', created_at: 2 } };
    await installMockApi(page, { workspaces: [localWorkspace], custom: async route => {
      const req = route.request(); const path = new URL(req.url()).pathname;
      if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
      if (path === '/api/agent/status') { await route.fulfill({ json: localStatus(hasLocalRuntime) }); return true; }
      if (path.endsWith('/proxy/workspaces/all')) {
        attempts++;
        await route.fulfill(online ? { json: { workspaces: [remoteWorkspace] } } : { status: 502, json: { error: 'SSH authentication expired. Authorization: Bearer private-value' } }); return true;
      }
      if (req.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(path)) sends.push({ path, body: req.postDataJSON() });
      return false;
    } });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Local project', exact: true }).first()).toBeVisible();
    const notice = page.getByRole('region', { name: 'Remote connection issues' });
    await expect(notice.getByText('build+ is unavailable')).toBeVisible();
    await expect(notice.getByText(/SSH authentication expired/)).toHaveCount(0);
    await notice.getByRole('button', { name: 'Details', exact: true }).click();
    const issue = page.getByRole('dialog', { name: 'Remote connections' });
    await issue.getByText('Connection details', { exact: true }).click();
    await expect(issue.getByText(/SSH authentication expired/).first()).toBeVisible();
    await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
    await issue.getByRole('button', { name: 'View logs' }).click();
    await expect(issue.getByLabel('Connection log')).toHaveValue(/attempt 2/);
    await issue.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(issue.getByText('Diagnostics copied.')).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { copiedDiagnostic: string }).copiedDiagnostic);
    expect(copied).toContain('HTTP 502'); expect(copied).not.toContain('private-value');
    await expect.poll(() => issue.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('remote-recovery.png') });
    if (hasLocalRuntime) {
      await issue.getByRole('button', { name: 'Ask local agent' }).click();
      await expect.poll(() => sends.length).toBe(1);
      expect(sends[0].path).toMatch(/^\/api\/chats\//);
      expect(JSON.stringify(sends[0].body)).toContain('SSH authentication expired');
      await expect(issue).toBeHidden();
      await expect(page.locator('html')).toHaveAttribute('data-native-surfaces-visible', 'true');
      await page.getByRole('button', { name: 'Remote connection details: build+ is unavailable' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-native-surfaces-visible', 'false');
    } else {
      await expect(issue.getByRole('button', { name: 'Ask local agent' })).toHaveCount(0);
      await expect(issue.getByText('No ready local runtime. View or copy diagnostics below.')).toBeVisible();
    }
    online = true;
    await issue.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(issue).toBeHidden();
    await expect(notice).toHaveCount(0);
    if (hasLocalRuntime) await expect(page.locator('html')).toHaveAttribute('data-native-surfaces-visible', 'true');
    await expect(page.getByRole('complementary').getByText('Remote recovered', { exact: true })).toBeVisible();
  });
}

test('multiple outages stay compact, dismiss without stopping retries, and reopen from the topbar', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  const connections = [connection, { ...connection, id: 'remote-d', name: 'build-' }];
  const attempts: Record<string, number> = {};
  const recovered = new Set<string>();
  const localWorkspace = { workspace: { id: 'local-ws', name: 'Local project', created_at: 1 }, nodes: [], trees: [], edges: [], messages: [], artifacts: [] };
  await installMockApi(page, { workspaces: [localWorkspace], custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections } }); return true; }
    if (path === '/api/agent/status') { await route.fulfill({ json: localStatus(true) }); return true; }
    const id = connections.find(item => path === `/api/backend-connections/${item.id}/proxy/workspaces/all`)?.id;
    if (id) {
      attempts[id] = (attempts[id] ?? 0) + 1;
      await route.fulfill(recovered.has(id) ? { json: { workspaces: [] } } : { status: 502, json: { error: 'Remote backend unavailable: fetch failed' } });
      return true;
    }
    return false;
  } });
  await page.goto('/');
  const notice = page.getByRole('region', { name: 'Remote connection issues' });
  await expect(notice.getByText('2 remotes unavailable')).toBeVisible();
  expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(40);
  await page.screenshot({ path: testInfo.outputPath('remote-notice-compact.png') });
  const sidebar = page.getByRole('complementary');
  const beforeDismiss = (await sidebar.boundingBox())!.y;
  await notice.getByRole('button', { name: 'Dismiss remote connection notice' }).click();
  await expect(notice).toHaveCount(0);
  await expect.poll(async () => (await sidebar.boundingBox())!.y).toBeLessThan(beforeDismiss);
  const afterDismiss = { ...attempts };
  await expect.poll(() => attempts['remote-c']).toBeGreaterThan(afterDismiss['remote-c']);
  await expect.poll(() => attempts['remote-d']).toBeGreaterThan(afterDismiss['remote-d']);
  await expect(notice).toHaveCount(0);
  const indicator = page.getByRole('button', { name: 'Remote connection details: 2 remotes unavailable' });
  await indicator.click();
  const drawer = page.getByRole('dialog', { name: 'Remote connections' });
  await expect(drawer.getByRole('heading', { name: 'build+', exact: true })).toBeVisible();
  await expect(drawer.getByRole('heading', { name: 'build-', exact: true })).toBeVisible();
  await drawer.getByRole('region', { name: 'Remote recovery: build+' }).getByText('Connection details', { exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Ask local agent' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('remote-details-drawer.png') });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(indicator).toBeFocused();
  await expect(page.locator('.drawer-shell-panel')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('remote-notice-dismissed.png') });
  await indicator.click();
  recovered.add('remote-c');
  await drawer.getByRole('region', { name: 'Remote recovery: build+' }).getByRole('button', { name: 'Try again' }).click();
  await expect(drawer.getByRole('region', { name: 'Remote recovery: build+' })).toHaveCount(0);
  await expect(drawer.getByRole('heading', { name: 'build-', exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  recovered.add('remote-d');
  await drawer.getByRole('region', { name: 'Remote recovery: build-' }).getByRole('button', { name: 'Try again' }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: /Remote connection details:/ })).toHaveCount(0);
});

test('long remote names and diagnostics fit a narrow dark window, with both close controls reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 620, height: 700 });
  const name = 'remote-development-'.repeat(8);
  const localWorkspace = { workspace: { id: 'local-ws', name: 'Local project', created_at: 1 }, nodes: [], trees: [], edges: [], messages: [], artifacts: [] };
  await installMockApi(page, { workspaces: [localWorkspace], custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/prefs') { await route.fulfill({ json: { prefs: { onboardingCompletedAt: 1, terminalPalette: 'gruvbox' } } }); return true; }
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [{ ...connection, name }] } }); return true; }
    if (path.endsWith('/proxy/workspaces/all')) { await route.fulfill({ status: 502, json: { error: 'Remote backend unavailable: ' + 'unbroken-error-'.repeat(30) } }); return true; }
    return false;
  } });
  await page.goto('/');
  const notice = page.getByRole('region', { name: 'Remote connection issues' });
  await expect(notice).toBeVisible();
  expect((await notice.boundingBox())!.height).toBeLessThanOrEqual(40);
  await expect.poll(() => notice.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await notice.getByRole('button', { name: 'Details', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Remote connections' });
  await drawer.getByText('Connection details', { exact: true }).click();
  await drawer.getByRole('button', { name: 'View logs' }).click();
  await expect(drawer.getByLabel('Connection log')).toBeVisible();
  await expect.poll(() => drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect.poll(() => drawer.locator('.remote-recovery-details').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('remote-details-narrow-dark.png') });
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.drawer-shell-panel')).toHaveCount(0);
  await notice.getByRole('button', { name: 'Dismiss remote connection notice' }).click();
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: /Remote connection details:/ }).click();
  await expect(drawer).toBeVisible();
  await page.locator('.drawer-shell-scrim').click({ position: { x: 5, y: 300 } });
  await expect(drawer).toBeHidden();
});
