import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

test.use({ reducedMotion: 'no-preference', launchOptions: { args: ['--enable-smooth-scrolling'] } });

async function alignment(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    const captions = document.querySelector<HTMLElement>('[data-pane-captions]')!;
    const panes = Array.from(strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]'));
    return {
      left: strip.scrollLeft,
      captionScroll: captions.scrollLeft,
      error: Math.max(...panes.map(pane => {
        const caption = captions.querySelector<HTMLElement>(`[data-pane-caption-id="${pane.dataset.nodeId}"]`)!;
        const bodyRect = pane.getBoundingClientRect();
        const captionRect = caption.getBoundingClientRect();
        return Math.max(Math.abs(bodyRect.left - captionRect.left), Math.abs(bodyRect.width - captionRect.width));
      })),
    };
  });
}

async function settlePanes(page: Page) {
  await page.locator('.terminal-dashboard').evaluate(async el => {
    let previous = el.scrollLeft;
    let stableFrames = 0;
    for (let frame = 0; frame < 180; frame++) {
      await new Promise(requestAnimationFrame);
      const moving = Array.from(el.children).some(child => child.getAnimations().length > 0);
      stableFrames = el.scrollLeft === previous && !moving ? stableFrames + 1 : 0;
      previous = el.scrollLeft;
      if (stableFrames >= 10) return;
    }
    throw new Error('Pane layout and automatic reveal did not settle');
  });
}

for (const native of [true, false]) {
  test(`titles follow pane scrolling with ${native ? 'native timeline' : 'fallback'}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1480, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    if (!native) await page.addInitScript(() => Object.defineProperty(window, 'ScrollTimeline', { value: undefined }));
    await installMockApi(page, { custom: async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/agent-runs') {
        await route.fulfill({ json: { runs: [] } }); return true;
      }
      if (path === '/api/agent-runs/subscribe') {
        await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true;
      }
      return false;
    } });
    await bootWithWorkspace(page, 'Pane scroll regression');
    await page.locator('[contenteditable="true"]').first().fill('Check pane and title alignment');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(1);
    for (let count = 2; count <= 3; count++) {
      await page.getByRole('button', { name: 'New pane', exact: true }).click();
      await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(count);
    }
    await settlePanes(page);
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
    expect(await page.locator('[data-pane-captions]').evaluate(el => el.getAnimations().some(animation =>
      animation.timeline !== document.timeline))).toBe(native);
    const strip = page.locator('.terminal-dashboard');
    await strip.evaluate(el => el.scrollTo({ left: 400, behavior: 'instant' }));
    await expect.poll(async () => (await alignment(page)).left).toBe(400);
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);

    // Real wheel input over both surfaces, alternating directions.
    for (const surface of ['.terminal-dashboard', '[data-pane-caption-viewport]']) {
      const box = (await page.locator(surface).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + (surface.includes('viewport') ? 22 : 100));
      for (const delta of [160, -100, 220, -180]) {
        const before = (await alignment(page)).left;
        await page.mouse.wheel(delta, 0);
        await expect.poll(async () => Math.abs((await alignment(page)).left - before)).toBeGreaterThan(20);
        await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
        expect((await alignment(page)).captionScroll).toBe(0);
      }
    }

    // Inspect every frame during native smooth scrolling, not just its endpoint.
    await strip.evaluate(el => el.scrollTo({ left: 800, behavior: 'instant' }));
    await expect.poll(async () => (await alignment(page)).left).toBe(800);
    const frames = await strip.evaluate(async el => {
      const body = el.firstElementChild!;
      const caption = document.querySelector('[data-pane-captions]')!.firstElementChild!;
      el.scrollTo({ left: 0, behavior: 'smooth' });
      const samples: Array<{ scroll: number; error: number }> = [];
      for (let i = 0; i < 50; i++) {
        await new Promise(requestAnimationFrame);
        samples.push({ scroll: el.scrollLeft, error: Math.abs(body.getBoundingClientRect().left - caption.getBoundingClientRect().left) });
      }
      return samples;
    });
    await info.attach('scroll-frames', { body: JSON.stringify(frames), contentType: 'application/json' });
    expect(frames.some(frame => frame.scroll > 0 && frame.scroll < 800), JSON.stringify(frames)).toBe(true);
    expect(Math.max(...frames.map(frame => frame.error))).toBeLessThan(2);
    // High-refresh displays can sample 50 frames before native scrolling ends.
    await expect.poll(async () => (await alignment(page)).left).toBe(0);

    await strip.evaluate(el => el.scrollTo({ left: 550, behavior: 'instant' }));
    await expect.poll(async () => (await alignment(page)).left).toBe(550);
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
    await page.mouse.move(10, 500);
    await page.screenshot({ path: info.outputPath('scrolled-desktop.png') });
    await strip.evaluate(el => el.scrollTo({ left: 0, behavior: 'instant' }));
    const handle = strip.locator(':scope > [data-node-id]').first().getByTitle('Drag to resize · Double-click to reset');
    const handleBox = (await handle.boundingBox())!;
    await page.mouse.move(handleBox.x + 4, handleBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(handleBox.x - 76, handleBox.y + 100, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(strip).toHaveCount(0);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await expect(strip).toBeVisible();
    await settlePanes(page);
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true })));
    await expect(strip.locator(':scope > [data-node-id]')).toHaveCount(2);
    await settlePanes(page);
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);

    await strip.evaluate(el => el.scrollTo({ left: 550, behavior: 'instant' }));
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath('aligned-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
    await strip.evaluate(el => el.scrollTo({ left: el.scrollWidth, behavior: 'instant' }));
    await expect.poll(async () => (await alignment(page)).error).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath('aligned-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}
