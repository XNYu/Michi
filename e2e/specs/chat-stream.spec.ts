import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

test.describe('chat stream', () => {
  test('user message → assistant chunks rendered → title applied', async ({ page }) => {
    await installMockApi(page);
    await bootWithWorkspace(page);

    const composer = page.locator('textarea').first();
    await composer.fill('hello kiro');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();

    // Chunks from defaultTurn are concatenated by the reducer.
    await expect(page.getByText('Hello from mock kiro.')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('This is a fake reply.')).toBeVisible();

    // Title event renders in multiple places (toast, sidebar, topbar) — any
    // single appearance proves the `title` SSE event reached the reducer.
    await expect(page.getByText('Mock turn').first()).toBeVisible();
  });

  test('follow-up chips appear after done', async ({ page }) => {
    await installMockApi(page);
    await bootWithWorkspace(page);

    await page.locator('textarea').first().fill('hi');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();

    // FollowUpRow renders the three follow-up suggestions from defaultTurn.
    for (const fu of ['Tell me more', 'What else?', 'Stop']) {
      await expect(page.getByText(fu)).toBeVisible({ timeout: 5_000 });
    }
  });
});
