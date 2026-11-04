import type { Locator, Page } from '@playwright/test';
import { expect, test, type CaptureMode } from '../fixtures/overlayDesktop';
import { bootWithWorkspace, installMockApi, sseBody } from '../fixtures/mockApi';
import { COMPOSER_EDITOR, openSettings } from '../fixtures/shell';

// Four overlays, real chunk consumption and entrance/exit motion in one turn.
test.setTimeout(60_000);

/** Actual stream reducer updates, not a CSS-only animated background. */
async function startStreaming(page: Page, mode: CaptureMode) {
  await installMockApi(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const probe = { captures: 0, push: (body: string) => controller.enqueue(new TextEncoder().encode(body)) };
    Object.assign(window, { overlayProbe: probe });
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (init?.method === 'POST' && /\/api\/chats\/[^/]+\/message$/.test(url.pathname)) {
        return new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return original(input, init);
    };
  });
  await bootWithWorkspace(page, 'Overlay streaming');
  // Install after boot: only the overlay needs this small desktop bridge.
  await page.evaluate(async (captureMode) => {
    const desktop = (window as unknown as { overlayDesktop?: { setCaptureMode: (mode: string) => Promise<void> } }).overlayDesktop;
    if (desktop) { await desktop.setCaptureMode(captureMode); return; }
    const probe = (window as unknown as { overlayProbe: { captures: number } }).overlayProbe;
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 200;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#826da8'; ctx.fillRect(0, 0, 320, 200);
    const image = canvas.toDataURL();
    Object.assign(window, { electron: captureMode === 'missing' ? {} : {
      captureBackdrop: async () => {
        probe.captures += 1;
        if (captureMode === 'failed') return null;
        if (captureMode === 'late') await new Promise(resolve => setTimeout(resolve, 350));
        return image;
      },
    } });
  }, mode);
  await page.locator(COMPOSER_EDITOR).first().fill('Keep working while I inspect the overlays.');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await push(page, sseBody([
    { event: 'chunk', data: { text: 'Streaming begins. ' } },
    { event: 'subagent_list_update', data: { subagents: [{
      sessionId: 'overlay-child', sessionName: 'Inspect rendering', agentName: 'Explore',
      status: 'working', initialQuery: 'Inspect rendering', group: '', dependsOn: [],
    }] } },
  ]));
  await expect(page.getByTestId('pane-background-work-badge')).toBeVisible();
}

async function push(page: Page, body: string) {
  await page.evaluate(value => (window as unknown as { overlayProbe: { push: (body: string) => void } }).overlayProbe.push(value), body);
}

async function resize(page: Page, width: number, height: number) {
  if (process.env.E2E_ELECTRON === '1') {
    await page.evaluate(size => (window as unknown as { overlayDesktop: { resize: (size: { width: number; height: number }) => Promise<void> } }).overlayDesktop.resize(size), { width, height });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
  } else await page.setViewportSize({ width, height });
}

async function expectStable(page: Page, surface: Locator, label: string) {
  await expect(surface).toBeVisible();
  await expect(surface).toHaveCSS('backdrop-filter', 'none');
  await expect(surface).toHaveCSS('opacity', '1');
  await expect.poll(() => surface.evaluate(element => element.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  const node = await surface.elementHandle();
  const bounds = await surface.boundingBox();
  for (let i = 0; i < 5; i += 1) {
    await push(page, sseBody([{ event: 'chunk', data: { text: `${label}-${i} ` } }]));
    await expect(page.locator('.terminal-message-assistant')).toContainText(`${label}-${i}`);
    expect(await surface.evaluate((current, original) => current === original, node)).toBe(true);
    await expect(surface).toHaveCSS('backdrop-filter', 'none');
    await expect(surface).toHaveCSS('opacity', '1');
    const current = (await surface.boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(current[key] - bounds![key])).toBeLessThan(0.5);
  }
}

for (const mode of ['success', 'failed', 'late', 'missing'] as const) {
  test.describe(`capture ${mode}`, () => {
    test.use({ overlayCaptureMode: mode });
    test(`desktop overlays keep their material and input while streaming (${mode})`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startStreaming(page, mode);
      if (mode === 'missing') {
        expect(await page.evaluate(() => typeof (window as unknown as { electron: { captureBackdrop?: unknown } }).electron.captureBackdrop)).toBe('undefined');
      }
      await resize(page, 1440, 960);

      await page.getByRole('button', { name: 'Search', exact: true }).click();
      const palette = page.getByRole('dialog', { name: 'Command palette' });
      await expect(palette).toHaveAttribute('data-glass', mode === 'success' ? 'frozen' : 'solid');
      const query = palette.getByPlaceholder('Search chats, commands, messages…');
      await query.fill('settings');
      await expectStable(page, palette, 'palette');
      await expect(query).toBeFocused();
      await expect(query).toHaveValue('settings');
      // Resize must not reintroduce live blur, even after a successful capture.
      await resize(page, 1400, 940);
      await expect(palette).toHaveAttribute('data-glass', 'solid');
      await expect(palette).toHaveCSS('backdrop-filter', 'none');
      await page.keyboard.press('Escape');

      await openSettings(page, 'Appearance');
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
      await expect(settings).toHaveAttribute('data-glass', mode === 'success' ? 'frozen' : 'solid');
      const search = settings.getByRole('searchbox', { name: 'Search settings' });
      await search.fill('corner');
      await expectStable(page, settings, 'settings');
      await expect(search).toBeFocused();
      await expect(search).toHaveValue('corner');
      await page.screenshot({ path: info.outputPath(`settings-${mode}.png`) });
      await settings.locator('.ui-overlay-header').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(settings).toHaveCount(0);

      await page.getByTestId('pane-background-work-badge').click();
      const drawer = page.getByRole('dialog', { name: 'Background work' });
      await expectStable(page, drawer, 'subagent');
      await expect(drawer.getByTestId('background-subagent-row')).toContainText('Inspect rendering');
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);

      // A menu has its own stronger CSS recipe and lazy stylesheet. Its live
      // blur must stay off regardless of the glass preference's minimum.
      await page.locator(COMPOSER_EDITOR).first().fill('/');
      const menu = page.getByRole('listbox', { name: 'Slash commands', exact: true });
      await expectStable(page, menu, 'menu');
      await page.screenshot({ path: info.outputPath(`menu-${mode}.png`) });
      await page.keyboard.press('Escape');
      await push(page, sseBody([{ event: 'chunk', data: { text: 'All overlays checked.' } }, { event: 'done', data: { stopReason: 'end_turn' } }]));
      await expect(page.locator('.terminal-message-assistant')).toContainText('All overlays checked.');
      expect(errors).toEqual([]);
    });
  });
}
