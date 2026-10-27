import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

test('recovery shows live stages and output before a concrete timeout error', async ({ page }, testInfo) => {
  await page.clock.install();
  const connection = { id: 'remote-progress', name: 'build+', transport: 'ssh', sshHost: 'build+', hasToken: true, createdAt: 1, updatedAt: 1 };
  const report = { id: 'live-attempt', host: 'build+', startedAt: '2026-10-18T08:34:48Z', stage: 'ssh',
    severity: 'info', message: 'Checking the saved remote Michi installation…', log: '[ssh] Checking installation\n', truncated: false };
  let stage: 'ssh' | 'tunnel' | 'error' = 'ssh';
  let attempts = 0;
  const recovery = () => {
    const diagnostic = stage === 'ssh' ? report : { ...report, stage: 'tunnel',
      severity: stage === 'error' ? 'error' : 'info', code: stage === 'error' ? 'recovery_timeout' : undefined,
      message: stage === 'error' ? 'Remote recovery timed out at tunnel after 45 seconds.' : 'Opening SSH forwarding…',
      log: report.log + '[ssh stderr] Proxy connected\n[tunnel] Opening forwarding\n' + (stage === 'error' ? '[error] Recovery timed out\n' : '') };
    return { connectionId: connection.id, phase: stage === 'error' ? 'error' : 'starting', message: diagnostic.message, diagnostic };
  };
  await installMockApi(page, { workspaces: [{ workspace: { id: 'local', name: 'Local notes', created_at: 1 }, nodes: [], trees: [], edges: [], messages: [], artifacts: [] }], custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/backend-connections') { await route.fulfill({ json: { connections: [connection] } }); return true; }
    if (path.endsWith('/proxy/workspaces/all')) {
      attempts++;
      await route.fulfill({ status: 502, json: { error: recovery().message, recovery: recovery() } }); return true;
    }
    if (path === '/api/backend-connections/recovery') {
      await route.fulfill({ json: { recoveries: [recovery()] } });
      return true;
    }
    return false;
  } });
  await page.goto('/');
  const notice = page.getByRole('region', { name: 'Remote connection issues' });
  await expect.poll(() => attempts).toBeGreaterThanOrEqual(2);
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Remote connection details:/ })).toHaveCount(0);
  await page.clock.fastForward(5 * 60_000);
  await page.getByRole('button', { name: /Remote connection details:/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Remote connections' });
  await drawer.getByText('Connection details', { exact: true }).click();
  await expect(drawer.getByText('In progress at', { exact: false })).toBeVisible();
  await drawer.getByRole('button', { name: 'View logs' }).click();
  const log = drawer.getByLabel('Connection log');
  await expect(log).toHaveValue(/Status: Checking the saved/);
  await expect(log).not.toHaveValue(/Error:|unknown:/);
  stage = 'tunnel';
  await expect(log).toHaveValue(/Status: Opening SSH forwarding[\s\S]*Proxy connected/);
  await expect(drawer.getByRole('button', { name: /^(Trying…|Try again)$/ })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('recovery-progress.png') });
  stage = 'error';
  await expect(log).toHaveValue(/Error: recovery_timeout: Remote recovery timed out at tunnel/);
  await expect(drawer.getByRole('button', { name: 'Try again', exact: true })).toBeEnabled();
  await expect(drawer.getByText('Failed at', { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('recovery-timeout.png') });
});
