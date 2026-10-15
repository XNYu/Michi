import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

test('links and agent requests follow the saved Browser preference', async ({ page }) => {
  let pendingUrl: string | null = null;
  await page.addInitScript(() => {
    const win = window as any;
    win.externalUrls = [];
    win.electron = {
      openExternal: (url: string) => win.externalUrls.push(url),
      browserCreate: async (surfaceId: string, _project: string, url: string) => ({ surfaceId, url, title: 'Browser', loading: false, canGoBack: false, canGoForward: false }),
      browserSetBounds: () => {}, browserDestroy: () => {},
    };
  });
  await installMockApi(page, { custom: async route => {
    if (new URL(route.request().url()).pathname.endsWith('/open-url/claim')) {
      const request = pendingUrl ? { id: 'agent-request', url: pendingUrl } : null;
      pendingUrl = null;
      await route.fulfill({ json: { request } });
      return true;
    }
    return false;
  } });
  await bootWithWorkspace(page);
  await page.locator('[contenteditable="true"]').first().fill('links');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  const clickLink = async (url: string) => {
    await page.evaluate(href => {
      const link = document.createElement('a');
      link.href = href; link.textContent = 'Test web link'; link.id = 'test-web-link';
      document.body.append(link);
    }, url);
    await page.locator('#test-web-link').click();
    await page.locator('#test-web-link').evaluate(el => el.remove());
  };
  await clickLink('https://example.com/internal');
  await expect(page.getByRole('textbox', { name: 'Browser address' })).toHaveValue('https://example.com/internal');
  await expect.poll(() => page.evaluate(() => (window as any).externalUrls)).toEqual([]);
  await page.getByRole('complementary').getByText('Settings', { exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Browser', exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Open links in' })).toHaveValue('internal');
  await settings.getByRole('combobox', { name: 'Open links in' }).selectOption('external');
  await page.keyboard.press('Escape');
  await clickLink('https://example.com/external');
  await expect.poll(() => page.evaluate(() => (window as any).externalUrls)).toEqual(['https://example.com/external']);
  pendingUrl = 'https://example.com/agent';
  await expect.poll(() => page.evaluate(() => (window as any).externalUrls)).toContain('https://example.com/agent');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('michi:v1:prefs')!).linkOpenTarget)).toBe('external');
  await page.reload();
  // The mock workspace API intentionally starts empty after a reload.
  await page.getByRole('dialog', { name: 'New workspace' }).getByRole('button', { name: 'Close', exact: true }).click();
  await clickLink('https://example.com/restored');
  await expect.poll(() => page.evaluate(() => (window as any).externalUrls)).toContain('https://example.com/restored');
});
