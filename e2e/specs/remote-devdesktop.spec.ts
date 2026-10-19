import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

for (const runtimes of [['codex', 'claude'], []]) {
  test(`connects and creates a remote workspace with ${runtimes.length} detected runtimes`, async ({ page }) => {
    const connection = { id: 'remote-c', name: 'build+', transport: 'ssh', sshHost: 'build+', remotePort: 4444, hasToken: true, createdAt: 1, updatedAt: 1 };
    let connected = false;
    let selectedRuntime = 'codex';
    const runtimeChanges: string[] = [];
    const calls: { host: string; install: boolean }[] = [];
    const commands: unknown[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    await installMockApi(page, { custom: async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/api/backend-connections') {
        await route.fulfill({ json: { connections: connected ? [connection] : [] } }); return true;
      }
      if (url.pathname === '/api/backend-connections/connect-ssh') {
        const body = request.postDataJSON(); calls.push(body); connected = body.install;
        await route.fulfill({ contentType: 'application/x-ndjson', body: [
          { type: 'progress', stage: 'ssh', message: 'Connecting…' },
          { type: 'result', result: connected ? { kind: 'connected', connection, home: '/home/u', runtimes } : { kind: 'install_required', host: 'build+' } },
        ].map(value => JSON.stringify(value)).join('\n') + '\n' }); return true;
      }
      if (url.pathname === '/api/backend-connections/remote-c/directories') {
        const project = url.searchParams.get('path') === '/home/u/project';
        await route.fulfill({ json: project ? { path: '/home/u/project', parent: '/home/u', entries: [] }
          : { path: '/home/u', parent: '/home', entries: [{ name: 'project', path: '/home/u/project' }] } }); return true;
      }
      if (url.pathname === '/api/backend-connections/remote-c/proxy/workspaces/all') {
        await route.fulfill({ json: { workspaces: [] } }); return true;
      }
      if (url.pathname === '/api/backend-connections/remote-c/proxy/agent/status') {
        await route.fulfill({ json: { runtime: selectedRuntime, label: selectedRuntime === 'codex' ? 'Codex' : 'Claude Code', hasRequiredKey: true,
          capabilities: { apiKeys: false, modes: false, permissions: false, models: false, providerModels: false, reasoning: false, warmSessions: false },
          availableRuntimes: runtimes.map(id => ({ id, label: id === 'codex' ? 'Codex' : 'Claude Code', available: true })) } }); return true;
      }
      if (url.pathname === '/api/backend-connections/remote-c/proxy/agent/options') {
        selectedRuntime = request.postDataJSON().runtime; runtimeChanges.push(selectedRuntime);
        await route.fulfill({ json: { ok: true } }); return true;
      }
      if (url.pathname === '/api/backend-connections/remote-c/proxy/ready') {
        await route.fulfill({ json: { status: 'ready', error: null } }); return true;
      }
      if (url.pathname.endsWith('/commands') && request.method() === 'POST') {
        commands.push(request.postDataJSON()); await route.fulfill({ json: { ok: true } }); return true;
      }
      return false;
    } });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: /New workspace/i });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Backend connection').selectOption('__add_remote__');
    await dialog.getByLabel(/\S+ SSH host$/).fill('build+');
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Install and connect' })).toBeVisible();
    expect(calls).toEqual([{ host: 'build+', install: false }]);
    await dialog.getByRole('button', { name: 'Install and connect' }).click();
    await expect(dialog.getByText(runtimes.length ? /Detected 2 runtimes: Codex, Claude Code/ : /No agent runtimes detected. Your machine is connected/)).toBeVisible();
    await expect(dialog.getByRole('combobox')).toHaveCount(1); // Machine only; runtime selection stays in the composer.
    await dialog.getByRole('button', { name: 'project /' }).click();
    await expect(dialog.getByLabel('Browse remote folder')).toHaveValue('/home/u/project');
    await dialog.getByRole('button', { name: 'Use this folder' }).click();
    await expect(dialog.getByPlaceholder('/home/you/project')).toHaveValue('/home/u/project');
    await dialog.getByRole('button', { name: 'create', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(pageErrors).toEqual([]);
    await expect(page.getByRole('button', { name: 'project', exact: true }).first()).toBeVisible();
    await expect.poll(() => JSON.stringify(commands)).toContain('/home/u/project');
    expect(calls).toEqual([{ host: 'build+', install: false }, { host: 'build+', install: true }]);
    expect(navigations).toBe(1);
    if (runtimes.length) {
      const editor = page.locator('[contenteditable="true"]').first();
      await editor.fill('Draft for the remote workspace');
      await page.getByRole('button', { name: /^Model settings:/ }).click();
      const picker = page.getByRole('dialog', { name: 'Model settings' });
      await expect(picker.getByRole('button', { name: /Select runtime: Codex/ })).toBeVisible();
      await picker.getByRole('button', { name: /Select runtime:/ }).click();
      await page.getByRole('menuitemradio', { name: 'Claude Code', exact: true }).click();
      await expect(picker.getByRole('button', { name: /Select runtime: Claude Code/ })).toBeVisible();
      expect(runtimeChanges).toEqual(['claude']);
      await expect(editor).toHaveText('Draft for the remote workspace');
    }
    expect(pageErrors).toEqual([]);
  });
}

for (const palette of ['bone', 'gruvbox']) {
  test(`remote settings remain readable in ${palette} with narrow content`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 980, height: 940 });
    await page.addInitScript(palette => localStorage.setItem('michi:v1:prefs', JSON.stringify({
      onboardingCompletedAt: 1, terminalPalette: palette,
    })), palette);
    const connections = [
      { id: 'remote-c', name: 'build+', transport: 'ssh', sshHost: 'build+', remotePort: 45489, tunnelStatus: 'connected', hasToken: true, createdAt: 1, updatedAt: 1 },
      { id: 'remote-other', name: 'build-secondary', transport: 'ssh', sshHost: 'builder-with-a-long-hostname.example.com', remotePort: 44083, tunnelStatus: 'disconnected', hasToken: true, createdAt: 1, updatedAt: 1 },
    ];
    await installMockApi(page, { custom: async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/backend-connections') {
        await route.fulfill({ json: { connections } }); return true;
      }
      if (url.pathname.endsWith('/proxy/workspaces/all') || url.pathname.endsWith('/proxy/workspaces')) {
        await route.fulfill({ json: { workspaces: [] } }); return true;
      }
      return false;
    } });
    await bootWithWorkspace(page, 'Remote design review');
    await page.getByText('Settings', { exact: true }).last().click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Connections', exact: true }).click();
    await expect(settings.getByText('SSH connected', { exact: true })).toHaveCount(2);
    const add = settings.getByRole('button', { name: 'Connect remote', exact: true });
    await expect(add).toBeVisible();
    await expect(settings.getByText('SSH launch:', { exact: false })).toHaveCount(0);
    await expect.poll(() => settings.locator('.terminal-settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    // Controls use the shared UI font, including the host input in the expanded form.
    const font = await settings.locator('h1').evaluate(el => getComputedStyle(el).fontFamily);
    expect(await add.evaluate(el => getComputedStyle(el).fontFamily)).toBe(font);
    await page.screenshot({ path: testInfo.outputPath(`settings-${palette}.png`) });
    await add.click();
    const host = settings.getByLabel(/\S+ SSH host$/);
    await host.fill('build+');
    expect(await host.evaluate(el => getComputedStyle(el).fontFamily)).toBe(font);
    await expect(settings.getByText(/Run.*in Terminal/)).toBeHidden();
    await settings.getByText('First time connecting?', { exact: true }).click();
    await expect(settings.getByText(/Run.*in Terminal/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`connect-${palette}.png`) });
    await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await settings.getByRole('button', { name: 'Manual setup…' }).click();
    await expect(settings.getByRole('heading', { name: 'Manual connection' })).toBeVisible();
    await page.setViewportSize({ width: 540, height: 850 });
    await expect.poll(() => settings.locator('.terminal-settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`manual-narrow-${palette}.png`) });
  });
}

for (const hasLocalRuntime of [true, false]) {
  test(`remote failure has logs, copy and ${hasLocalRuntime ? 'local agent handoff' : 'no-runtime fallback'}`, async ({ page }, testInfo) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { (window as unknown as { copiedDiagnostic: string }).copiedDiagnostic = text; } } });
    });
    const diagnostic = { id: 'attempt-e2e', host: 'build+', startedAt: '2026-10-16T12:00:00Z', stage: 'tunnel', code: 'setup_failed', message: 'SSH tunnel failed: bind: Address already in use', log: '[ssh] Remote service healthy\n[tunnel] bind: Address already in use\n[exit] code=255', truncated: false };
    const sends: { path: string; body: unknown }[] = [];
    const sessions: { path: string; body: unknown }[] = [];
    const remoteWorkspace = { workspace: { id: 'remote-existing', name: 'Remote existing workspace', created_at: 1, cwd: '/home/u/project' }, nodes: [], trees: [], edges: [], messages: [], artifacts: [] };
    await installMockApi(page, { custom: async route => {
      const request = route.request(); const url = new URL(request.url());
      if (url.pathname === '/api/backend-connections') {
        await route.fulfill({ json: { connections: [{ id: 'remote-existing', name: 'Existing remote', transport: 'ssh', sshHost: 'existing', remotePort: 4444, hasToken: true }] } }); return true;
      }
      if (url.pathname === '/api/backend-connections/remote-existing/proxy/workspaces/all') {
        await route.fulfill({ json: { workspaces: [remoteWorkspace] } }); return true;
      }
      if (url.pathname === '/api/backend-connections/remote-existing/proxy/workspaces') {
        await route.fulfill({ json: { workspaces: [remoteWorkspace.workspace] } }); return true;
      }
      if (url.pathname.endsWith('/proxy/agent/status')) {
        await route.fulfill({ json: { runtime: 'remote-mock', label: 'Remote only', hasRequiredKey: true, availableRuntimes: [{ id: 'remote-mock', label: 'Remote only', available: true }], capabilities: {} } }); return true;
      }
      if (url.pathname === '/api/backend-connections/connect-ssh') {
        await route.fulfill({ contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'error', code: diagnostic.code, message: diagnostic.message, diagnostic }) + '\n' }); return true;
      }
      if (url.pathname === '/api/agent/status') {
        await route.fulfill({ json: { runtime: 'mock', label: 'Local Mock', hasRequiredKey: hasLocalRuntime,
          capabilities: { modes: false, permissions: false, providerModels: false, reasoning: false, apiKeys: false, warmSessions: false },
          availableRuntimes: hasLocalRuntime ? [{ id: 'mock', label: 'Local Mock', available: true, requiresApiKey: false }] : [],
        } }); return true;
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/ensure-session')) sessions.push({ path: url.pathname, body: request.postDataJSON() });
      if (request.method() === 'POST' && /\/chats\/[^/]+\/message$/.test(url.pathname)) sends.push({ path: url.pathname, body: request.postDataJSON() });
      return false;
    } });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Remote existing workspace', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Remote existing workspace', exact: true }).first().click();
    await page.getByText('Settings', { exact: true }).last().click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    await settings.getByRole('button', { name: 'Connections', exact: true }).click();
    await settings.getByRole('button', { name: 'Connect remote', exact: true }).click();
    await settings.getByLabel(/\S+ SSH host$/).fill('build+');
    await settings.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(settings.getByRole('alert')).toContainText('Address already in use');
    await settings.getByRole('button', { name: 'View logs' }).click();
    await expect(settings.getByLabel('Connection log')).toHaveValue(/Stage: tunnel[\s\S]*code=255/);
    await settings.getByRole('button', { name: 'Copy diagnostics' }).click();
    await expect(settings.getByText('Diagnostics copied.')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { copiedDiagnostic: string }).copiedDiagnostic)).toContain('code=255');
    await expect.poll(() => settings.locator('.terminal-settings-content').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('diagnostics.png') });
    if (hasLocalRuntime) {
      await settings.getByRole('button', { name: 'Ask local agent' }).click();
      await expect(settings).toBeHidden();
      await expect.poll(() => sends.length).toBe(1);
      expect(sends[0].path).toMatch(/^\/api\/chats\//);
      expect(JSON.stringify(sends[0].body)).toContain('Address already in use');
      expect(JSON.stringify(sessions[0].body)).toContain('mock');
      expect(sessions[0].path).toMatch(/^\/api\/nodes\//);
      await expect(page.getByText('Hello from mock kiro.', { exact: false }).first()).toBeVisible();
    } else {
      await expect(settings.getByRole('button', { name: 'Ask local agent' })).toHaveCount(0);
      await expect(settings.getByText('No ready local runtime. View or copy diagnostics below.')).toBeVisible();
      expect(sends).toEqual([]);
    }
  });
}
