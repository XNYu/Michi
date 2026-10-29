import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { areaButton, openArea } from '../fixtures/shell';

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, {
    workspaces: [{ workspace: { id: 'ws-1', name: 'Scheduled workspace', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }],
    custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/meta-agent/overview') {
        await route.fulfill({ json: {
          state: 'running', runtime: { runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, followsGlobal: true },
          today: { checks: 0, checksTruncated: false, modelCalls: 0, writes: 0, pendingProposals: 0 },
          cursors: [], recentRuns: [], managedJobIds: [],
        } });
        return true;
      }
      if (path === '/api/scheduled-jobs') {
        await route.fulfill({ json: {
          jobs: [{
            id: 'job-1', workspaceId: 'ws-1', name: 'Morning digest', prompt: 'Summarize overnight changes',
            schedule: { kind: 'every', everySeconds: 3600 }, enabled: true, autoPaused: false,
            runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust',
            sessionMode: 'fresh', notify: true, timeoutSeconds: 1800, consecutiveFailures: 0,
            activeRunId: null, lastRunAt: null, nextRunAt: null, lastStatus: null, lastError: null,
            persistentNodeId: null, createdAt: 1, updatedAt: 1,
          }],
          scheduler: { active: true, serviceMode: false, timezone: 'UTC' },
        } });
        return true;
      }
      if (path === '/api/scheduled-jobs/job-1/runs') {
        await route.fulfill({ json: { runs: [] } });
        return true;
      }
      return false;
    },
  });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
}

test('Scheduled detail participates in back/forward history and has a direct route home', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  await openArea(page, 'scheduled');
  const list = page.getByRole('heading', { level: 1, name: 'Scheduled', exact: true });
  const detail = page.getByRole('heading', { level: 1, name: 'Meta agent · Maintain Pages', exact: true });
  const systemRow = page.locator('.scheduled-side').getByRole('button', { name: 'Meta agent · maintain Pages System', exact: true });
  const back = page.getByRole('button', { name: 'Navigate back', exact: true });
  const forward = page.getByRole('button', { name: 'Navigate forward', exact: true });
  await expect(list).toBeVisible();
  await systemRow.click();
  await expect(detail).toBeVisible();
  await back.click();
  await expect(list).toBeVisible();
  await expect(systemRow).not.toHaveAttribute('aria-current');
  await back.click();
  await expect(page.locator('.home-page')).toBeVisible();
  await forward.click();
  await expect(list).toBeVisible();
  await page.keyboard.press('ControlOrMeta+]');
  await expect(detail).toBeVisible();
  await openArea(page, 'conversations');
  await expect(areaButton(page, 'conversations')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(detail).toBeVisible();
  await page.screenshot({ path: info.outputPath('scheduled-detail.png') });
  await page.getByRole('button', { name: 'SCHEDULED', exact: true }).click();
  await expect(list).toBeVisible();
  await back.click();
  await expect(detail).toBeVisible();
  await openArea(page, 'scheduled');
  await expect(list).toBeVisible();
  expect(errors).toEqual([]);
});

test('ordinary job details and sidebar selection restore together after closing', async ({ page }) => {
  await boot(page);
  await openArea(page, 'scheduled');
  await page.getByRole('button', { name: 'Open Morning digest', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Scheduled job', exact: true });
  await expect(dialog.getByRole('heading', { name: 'Morning digest', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const row = page.locator('.scheduled-side').getByRole('button', { name: 'Morning digest', exact: true });
  await expect(row).not.toHaveAttribute('aria-current');
  await page.getByRole('button', { name: 'Navigate back', exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('.scheduled-side [aria-label="Morning digest"]')).toHaveAttribute('aria-current', 'true');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await row.click();
  await expect(dialog).toBeVisible();
});
