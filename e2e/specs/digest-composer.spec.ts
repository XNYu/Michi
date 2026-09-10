import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

const markdown = '# Release decisions\n\nShip the editor improvements with focused regression coverage.\n\n## Next steps\n\nVerify attachments, context references, and first-turn Agent selection.';

async function bootDigest(page: Page) {
  const ensures: Array<Record<string, any>> = [];
  const messages: Array<Record<string, any>> = [];
  const status = {
    runtime: 'mock', label: 'Mock Runtime', model: 'fast', reasoning: 'medium',
    customAgentsEnabled: false, hasRequiredKey: true,
    capabilities: { modes: true, models: true, providerModels: false, reasoning: true },
    availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }],
  };
  await installMockApi(page, {
    custom: async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
      const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (path === '/agent/status') { await json(status); return true; }
      if (path === '/agent/options') {
        Object.assign(status, request.postDataJSON());
        await json({ ok: true });
        return true;
      }
      if (path === '/modes') {
        await json({ availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] });
        return true;
      }
      if (path === '/agent/models') {
        await json({ models: [{ id: 'fast', label: 'Fast' }, { id: 'deep', label: 'Deep' }], sanitizedModel: null });
        return true;
      }
      if (path === '/digests/stream') {
        await route.fulfill({
          contentType: 'text/event-stream',
          body: `event: done\ndata: ${JSON.stringify({ markdown })}\n\n`,
        });
        return true;
      }
      if (path === '/uploads/web-cwd') { await json({ cwd: '/mock' }); return true; }
      if (path === '/workspaces/import-file') {
        await json({ name: 'notes', displayName: 'notes.txt', filePath: '.attachments/notes.txt', size: 12 });
        return true;
      }
      if (request.method() === 'POST' && /^\/nodes\/[^/]+\/ensure-session$/.test(path)) {
        ensures.push(request.postDataJSON());
      }
      if (request.method() === 'POST' && /^\/chats\/[^/]+\/message$/.test(path)) {
        messages.push(request.postDataJSON());
      }
      return false;
    },
  });
  await bootWithWorkspace(page, 'Digest composer checks');
  await page.locator('[contenteditable="true"]').fill('Review the release decisions');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('Hello from mock kiro.').first()).toBeVisible();
  await page.getByRole('button', { name: 'Digest', exact: true }).click();
  await page.getByRole('button', { name: 'Create digest', exact: true }).click();
  await expect(page.getByText('Release decisions', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.terminal-composer [contenteditable="true"]')).toBeVisible();
  return { ensures, messages };
}

test('Digest uses the Home editor, uploads files, selects an Agent/model and sends with digest context', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { ensures, messages } = await bootDigest(page);
  const editor = page.locator('.terminal-composer [contenteditable="true"]');

  await page.getByTitle('Mention context or node', { exact: true }).click();
  await expect(editor).toHaveText('@');
  await page.keyboard.press('Escape');
  await editor.fill('Explain the rollout');
  await editor.press('Shift+Enter');
  await editor.pressSequentially('and validation');
  expect(ensures).toHaveLength(1);

  await page.getByTitle('Attach file', { exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('release notes'),
  });
  await expect(page.locator('.t-att-pending-file')).toContainText('notes.txt');

  await page.locator('[title^="Switch agent"]').click();
  await page.getByText('Build', { exact: true }).click();
  await expect(page.getByTitle('Switch agent — Build', { exact: true })).toBeVisible();
  await page.locator('[title^="Model —"]').click();
  await page.getByText('Deep', { exact: true }).click();
  await expect(page.getByTitle('Model — Deep', { exact: true })).toBeVisible();
  await page.locator('[title^="Effort —"]').click();
  await page.getByText('High', { exact: true }).click();
  await expect(page.getByTitle('Effort — High', { exact: true })).toBeVisible();

  await page.screenshot({ path: process.env.DIGEST_SCREENSHOT ?? testInfo.outputPath('digest-composer-desktop.png'), fullPage: true });
  await page.locator('.terminal-composer').screenshot({
    path: process.env.DIGEST_COMPOSER_SCREENSHOT ?? testInfo.outputPath('digest-composer.png'),
  });
  await editor.press('Enter');
  await expect.poll(() => ensures.length).toBe(2);
  expect(ensures[1]).toMatchObject({ runtimeId: 'mock', modelId: 'deep', reasoning: 'high', modeId: 'build' });
  expect(ensures[1].mergeContexts).toEqual([expect.stringContaining('Release decisions')]);
  expect(ensures[1].graphPrerequisite.node.treeId).toBe(ensures[0].graphPrerequisite.node.treeId);
  await expect.poll(() => messages.length).toBe(2);
  expect(messages[1].text).toContain('Explain the rollout\nand validation');
  expect(messages[1].text).toContain('[Attached files:');
  expect(messages[1].text).toContain('/mock/.attachments/notes.txt');
  expect(errors).toEqual([]);
});

test('Digest drafts remain separate from Home and the composer stays usable in a narrow viewport', async ({ page }, testInfo) => {
  await bootDigest(page);
  const editor = page.locator('.terminal-composer [contenteditable="true"]');
  await editor.fill('Digest-only draft');
  await page.getByRole('button', { name: 'Go home', exact: true }).click();
  await expect(editor).toHaveText('');
  await editor.fill('Home-only draft');
  await page.getByRole('button', { name: 'Digest', exact: true }).click();
  await expect(editor).toHaveText('Digest-only draft');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(editor).toBeVisible();
  const composer = page.locator('.terminal-composer');
  const frame = await composer.boundingBox();
  const send = await page.getByRole('button', { name: 'Send (Enter)', exact: true }).boundingBox();
  expect(frame).not.toBeNull();
  expect(send).not.toBeNull();
  expect(frame!.width).toBeGreaterThan(250);
  expect(frame!.x + frame!.width).toBeLessThanOrEqual(390);
  expect(send!.x + send!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
  await page.screenshot({ path: process.env.DIGEST_MOBILE_SCREENSHOT ?? testInfo.outputPath('digest-composer-mobile.png'), fullPage: true });
});
