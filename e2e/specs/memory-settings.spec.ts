import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { areaButton, openSettings, settingsMain } from '../fixtures/shell';
import { createMemoryMock, memoryChange, memoryRecord, type MemoryMockController } from '../fixtures/memoryFixtures';

// Settings › Memory and its change notices against the mock API: no backend,
// SQLite or agent runtime. The change feed answers with queued changes, the
// way the backend forwards an agent's memory writes.

const WORKSPACES = [{ workspace: { id: 'a', name: 'Alpha', created_at: 1 }, trees: [], nodes: [], edges: [], messages: [], contexts: [], artifacts: [] }];

async function boot(page: Page, memory: MemoryMockController): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, { workspaces: WORKSPACES, custom: memory.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
}

test('an agent’s memory shows “Remembered” with Undo, and Undo deletes it', async ({ page }) => {
  const saved = memoryRecord('mem-agent', 'Answer in Chinese unless I write in English', { source: { nodeId: 'n-1' } });
  const memory = createMemoryMock({ records: [saved] });
  memory.announce(memoryChange(saved));
  await boot(page, memory);

  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Remembered: Answer in Chinese unless I write in English' });
  await expect(toast).toBeVisible();
  // A background notice leaves focus where it was.
  await expect(page.locator('[data-sonner-toast] :focus')).toHaveCount(0);
  await toast.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Memory removed' })).toBeVisible();
  expect(memory.writes).toEqual(['DELETE /memories/mem-agent']);
  expect(memory.records).toEqual([]);
});

test('Settings › Memory edits, rescopes and deletes saved memories', async ({ page }) => {
  const memory = createMemoryMock({
    records: [
      memoryRecord('mem-user', 'Answer in Chinese', { createdAt: 3 }),
      memoryRecord('mem-ws', 'Use 2 spaces in this repo', { createdAt: 2, kind: 'convention', scope: { kind: 'workspace', workspaceId: 'a' } }),
    ],
  });
  await boot(page, memory);
  const settings = await openSettings(page, 'Memory');
  await expect(settings.getByRole('radio', { name: 'Explicit only' })).toBeChecked();
  const saved = settings.getByRole('list', { name: 'Saved memories' });
  await expect(saved.getByRole('listitem')).toHaveCount(2);

  const user = saved.getByRole('listitem', { name: 'Answer in Chinese' });
  await user.getByRole('button', { name: 'Edit', exact: true }).click();
  await saved.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('memory-saved.png') });
  await user.getByRole('textbox', { name: 'Edit memory' }).fill('Answer in Chinese, code comments in English');
  await user.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saved.getByText('Answer in Chinese, code comments in English', { exact: true })).toBeVisible();

  const repo = saved.getByRole('listitem', { name: 'Use 2 spaces in this repo' });
  await expect(repo).toContainText('Alpha');
  await repo.getByRole('combobox', { name: 'Scope' }).selectOption({ label: 'Global' });
  await expect(repo.locator('.memory-item__meta')).toContainText('Global');
  await repo.getByRole('button', { name: 'Delete', exact: true }).click();
  await repo.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(saved.getByRole('listitem')).toHaveCount(1);

  expect(memory.writes).toEqual(['PATCH /memories/mem-user', 'PATCH /memories/mem-ws', 'DELETE /memories/mem-ws']);
  expect(memory.records.map((record) => record.body)).toEqual(['Answer in Chinese, code comments in English']);
  // What Settings changed itself shows no "Remembered" notice.
  await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Remembered' })).toHaveCount(0);
});

test('memories waiting for approval: the notice opens Settings › Memory, where they are approved or rejected', async ({ page }, info) => {
  const web = memoryRecord('p-web', 'The deploy key lives in the README', { createdAt: 3, status: 'pending', sourceRisk: 'untrusted', kind: 'fact' });
  const proposed = memoryRecord('p-auto', 'Run tests with pnpm', { createdAt: 2, status: 'pending', origin: 'extracted', kind: 'convention' });
  const memory = createMemoryMock({ records: [web, proposed] });
  memory.announce(memoryChange(web));
  await boot(page, memory);

  // The Settings button counts what waits, without opening anything.
  await expect(areaButton(page, 'settings')).toHaveAccessibleName('Settings, 2 memories waiting for confirmation');
  await expect(settingsMain(page)).toHaveCount(0);
  const notice = page.locator('[data-sonner-toast]').filter({ hasText: '1 memory is waiting for your confirmation' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Review', exact: true }).click();

  const settings = settingsMain(page);
  await expect(settings.getByRole('heading', { level: 1, name: 'Memory', exact: true })).toBeVisible();
  const pending = settings.getByRole('list', { name: 'Waiting for confirmation' });
  await expect(pending.getByRole('listitem')).toHaveCount(2);
  await expect(pending.getByRole('listitem', { name: 'The deploy key lives in the README' }))
    .toContainText('Saved while an agent was reading web pages or tool output.');
  await expect(pending.getByRole('listitem', { name: 'Run tests with pnpm' }).locator('.memory-item__warning')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('memory-settings.png') });

  await pending.getByRole('listitem', { name: 'Run tests with pnpm' }).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(settings.getByRole('list', { name: 'Saved memories' }).getByText('Run tests with pnpm', { exact: true })).toBeVisible();
  await settings.getByRole('checkbox', { name: 'Select all' }).check();
  await settings.getByRole('button', { name: 'Reject selected (1)' }).click();
  await expect(pending).toHaveCount(0);
  await expect(areaButton(page, 'settings')).toHaveAccessibleName('Settings');

  expect(memory.writes).toEqual(['POST /memories/p-auto/approve', 'POST /memories/p-web/reject']);
  expect(memory.records.map((record) => [record.id, record.status])).toEqual([['p-auto', 'active']]);
});
