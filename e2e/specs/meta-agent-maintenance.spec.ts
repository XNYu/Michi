import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';

test('automatic maintenance has one system entry and global controls independent of prompt jobs', async ({ page }) => {
  let paused = false;
  const promptWrites: string[] = [];
  const checks: string[] = [];
  const overview = () => ({
    state: paused ? 'paused' : 'running',
    runtime: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
    today: { checks: 12, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
    lastCheckedAt: Date.now() - 60_000, recentRuns: [], managedJobIds: ['legacy-a', 'legacy-b'],
    cursors: [
      { workspaceId: 'a', workspaceName: 'Alpha', cursor: 4, unread: 0, lastRunAt: null, state: 'synced' },
      { workspaceId: 'b', workspaceName: 'Beta', cursor: 2, unread: 0, lastRunAt: null, state: 'paused' },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, {
    workspaces: ['a', 'b'].map(id => ({ workspace: { id, name: id === 'a' ? 'Alpha' : 'Beta', created_at: 1 },
      trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] })),
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/scheduled-jobs') && route.request().method() !== 'GET') promptWrites.push(path);
      if (path === '/api/meta-agent/pause' || path === '/api/meta-agent/resume') {
        checks.push(path); paused = path.endsWith('/pause');
        await route.fulfill({ json: overview() }); return true;
      }
      if (path === '/api/meta-agent/overview') { await route.fulfill({ json: overview() }); return true; }
      if (path === '/api/scheduled-jobs') {
        await route.fulfill({ json: { jobs: [], scheduler: { active: true, serviceMode: false, timezone: 'UTC' } } }); return true;
      }
      return false;
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'scheduled');
  await expect(page.locator('.sched-row[data-system]')).toHaveCount(1);
  await expect(page.locator('.sched-row')).toHaveCount(1);
  await expect(page.getByText('Checks every 60 s · AI only for pending work', { exact: true })).toBeVisible();
  await expect(page.locator('.sched-row[data-system]')).toContainText('Checked');
  await page.getByRole('button', { name: 'Open Meta agent · maintain Pages', exact: true }).click();
  await expect(page.getByText('One background check every 60 seconds finds pending work across workspaces. AI runs only when there is work to process.')).toBeVisible();
  await expect(page.getByText('Paused in this workspace', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause background updates', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume background updates', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume background updates', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause background updates', exact: true })).toBeVisible();
  await expect(page.getByText('Paused in this workspace', { exact: true })).toBeVisible();
  expect(checks).toEqual(['/api/meta-agent/pause', '/api/meta-agent/resume']);
  expect(promptWrites).toEqual([]);
});
