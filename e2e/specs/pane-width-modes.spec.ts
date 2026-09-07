import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

type Mode = 'fixed' | 'half' | 'adaptive';
const panes = (page: Page) => page.locator('.terminal-dashboard > [data-node-id]');

async function installLayoutApi(page: Page) {
  await installMockApi(page, {
    custom: async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().method() === 'GET' && pathname === '/api/agent-runs') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ runs: [] }) });
        return true;
      }
      if (pathname === '/api/agent-runs/subscribe') {
        await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' });
        return true;
      }
      return false;
    },
  });
}

async function measurements(page: Page) {
  return page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    const captions = document.querySelector<HTMLElement>('[data-pane-captions]')!;
    return {
      available: strip.clientWidth,
      widths: Array.from(strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')).map(el => el.getBoundingClientRect().width),
      captionWidths: Array.from(captions.children).map(el => el.getBoundingClientRect().width),
      lefts: Array.from(strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')).map(el => el.getBoundingClientRect().left),
      captionLefts: Array.from(captions.children).map(el => el.getBoundingClientRect().left),
      scrollLeft: strip.scrollLeft,
    };
  });
}

async function openSettings(page: Page) {
  await page.getByRole('complementary').getByText('Settings', { exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Pane width mode' })).toBeVisible();
  await expect.poll(async () => {
    const box = (await page.getByRole('dialog', { name: 'Settings', exact: true }).boundingBox())!;
    return box.x + box.width;
  }).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function setMode(page: Page, mode: Mode) {
  await openSettings(page);
  await page.getByRole('combobox', { name: 'Pane width mode' }).selectOption(mode);
  await page.getByRole('slider', { name: 'Default pane width' }).evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '800');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Pane width mode' })).toBeHidden();
}

async function assertWidths(page: Page, mode: Mode, count: number) {
  await expect(panes(page)).toHaveCount(count);
  await expect.poll(async () => {
    const { available, widths, captionWidths, lefts, captionLefts } = await measurements(page);
    const expected = count === 1 ? available : mode === 'half' || (mode === 'adaptive' && count === 2) ? available / 2 : Math.min(800, available);
    return widths.every(width => Math.abs(width - expected) < 1)
      && captionWidths.every((width, i) => Math.abs(width - widths[i]) < 1)
      && captionLefts.every((left, i) => Math.abs(left - lefts[i]) < 2);
  }).toBe(true);
}

async function closeFocused(page: Page) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
  });
}

test.describe('pane width modes', () => {
  test.use({ viewport: { width: 1480, height: 1000 } });

  for (const mode of ['fixed', 'half', 'adaptive'] as const) {
    test(`${mode}: one through four panes, shared caption geometry, and persistence`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await installLayoutApi(page);
      await bootWithWorkspace(page, 'Pane layout comparison');
      await page.locator('[contenteditable="true"]').first().fill('Compare pane layout behavior');
      await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
      await expect(page.locator('.terminal-dashboard')).toBeVisible();
      await setMode(page, mode);
      await assertWidths(page, mode, 1);

      // Capture real browser frames, including the two separate grid surfaces.
      const frames = await page.evaluate(async () => {
        (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
        const samples: Array<{ body: number[]; captions: number[] }> = [];
        for (let i = 0; i < 24; i++) {
          await new Promise(requestAnimationFrame);
          samples.push({
            body: getComputedStyle(document.querySelector('.terminal-dashboard')!).gridTemplateColumns.split(' ').map(parseFloat),
            captions: getComputedStyle(document.querySelector('[data-pane-captions]')!).gridTemplateColumns.split(' ').map(parseFloat),
          });
        }
        return samples;
      });
      await assertWidths(page, mode, 2);
      const after = await measurements(page);
      await info.attach('layout-frames', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
      expect(frames.some(frame => frame.body[0] > after.widths[0] + 10 && frame.body[0] < after.available - 10)).toBe(true);
      expect(frames.every(frame => frame.body.length === frame.captions.length && frame.body.every((width, i) => Math.abs(width - frame.captions[i]) < 2)), JSON.stringify(frames)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${mode}-two-panes.png`) });

      for (const count of [3, 4]) {
        const reveal = await page.evaluate(async () => {
          const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
          const captions = document.querySelector<HTMLElement>('[data-pane-captions]')!;
          const start = strip.scrollLeft;
          (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
          const samples: Array<{ scroll: number; captionScroll: number; progress: number | null; width: number }> = [];
          for (let i = 0; i < 30; i++) {
            await new Promise(requestAnimationFrame);
            samples.push({
              scroll: strip.scrollLeft,
              captionScroll: captions.scrollLeft,
              progress: strip.getAnimations()[0]?.effect?.getComputedTiming().progress ?? null,
              width: parseFloat(getComputedStyle(strip).gridTemplateColumns.split(' ').at(-1)!),
            });
          }
          return { start, samples };
        });
        await assertWidths(page, mode, count);
        await info.attach(`reveal-${count}-frames`, { body: JSON.stringify(reveal, null, 2), contentType: 'application/json' });
        const final = reveal.samples.at(-1)!;
        expect(reveal.samples.some(s => s.progress !== null && s.progress > 0 && s.progress < 0.95
          && s.scroll > reveal.start + 10 && s.width < final.width - 10), JSON.stringify(reveal)).toBe(true);
        expect(reveal.samples.every(s => Math.abs(s.scroll - s.captionScroll) < 2), JSON.stringify(reveal)).toBe(true);
        expect(reveal.samples.filter(s => s.progress === null).every(s => Math.abs(s.scroll - final.scroll) < 2)).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${mode}-four-panes.png`) });
      for (const count of [3, 2, 1]) {
        await closeFocused(page);
        await assertWidths(page, mode, count);
      }
      await openSettings(page);
      await page.screenshot({ path: info.outputPath(`${mode}-settings.png`) });
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('michi:v1:prefs') ?? '{}').paneWidthMode)).toBe(mode);
      await page.reload();
      await expect(page.locator('.terminal-shell')).toBeVisible();
      // This fixture intentionally returns no backend workspaces after reload.
      const workspaceDialog = page.getByRole('dialog', { name: 'New workspace' });
      await expect(workspaceDialog).toBeVisible();
      await workspaceDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await openSettings(page);
      await expect(page.getByRole('combobox', { name: 'Pane width mode' })).toHaveValue(mode);
      expect(errors).toEqual([]);
    });
  }

  test('switching policies is live and keeps custom widths; resize bypasses animation', async ({ page }) => {
    await installLayoutApi(page);
    await bootWithWorkspace(page);
    await page.getByRole('button', { name: 'New pane', exact: true }).click();
    await expect(page.locator('.terminal-dashboard')).toBeVisible();
    await page.getByRole('button', { name: 'New pane', exact: true }).click();
    await setMode(page, 'half');
    await assertWidths(page, 'half', 2);
    await setMode(page, 'fixed');
    await assertWidths(page, 'fixed', 2);
    await setMode(page, 'adaptive');
    await assertWidths(page, 'adaptive', 2);

    const handle = panes(page).first().getByTitle('Drag to resize · Double-click to reset');
    const box = (await handle.boundingBox())!;
    const before = (await measurements(page)).widths[0];
    await page.mouse.move(box.x + 4, box.y + 180);
    await page.mouse.down();
    await page.mouse.move(box.x - 86, box.y + 180, { steps: 4 });
    await expect.poll(async () => Math.abs((await measurements(page)).widths[0] - (before - 90))).toBeLessThan(2);
    expect(await page.locator('.terminal-dashboard').evaluate(el => el.getAnimations().length)).toBe(0);
    await page.mouse.up();
    await setMode(page, 'fixed');
    await expect.poll(async () => Math.abs((await measurements(page)).widths[0] - (before - 90))).toBeLessThan(2);
    await handle.dblclick();
    await assertWidths(page, 'fixed', 2);
  });

  test('reduced motion and narrow windows retain the selected sizing policy', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installLayoutApi(page);
    await bootWithWorkspace(page);
    await page.getByRole('button', { name: 'New pane', exact: true }).click();
    await setMode(page, 'fixed');
    await page.getByRole('button', { name: 'New pane', exact: true }).click();
    await assertWidths(page, 'fixed', 2);
    expect(await page.locator('.terminal-dashboard').evaluate(el => el.getAnimations().length)).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertWidths(page, 'fixed', 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await closeFocused(page);
    await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
    await assertWidths(page, 'fixed', 1);
  });

  test('opening existing chats reveals them while they expand, including a reopened chat', async ({ page }, info) => {
    await installLayoutApi(page);
    await page.addInitScript(() => {
      localStorage.clear();
      sessionStorage.clear();
      const ids = ['root', 'second', 'third', 'fourth'];
      const nodes = Object.fromEntries(ids.map(id => [id, {
        nodeId: id, kind: 'chat', chatId: null, projectId: 'reveal-ws',
        title: `${id} conversation`, status: 'idle', followUps: [],
        messages: [
          { id: `${id}-question`, role: 'user', text: `Review the ${id} part of the implementation.`, toolCalls: [], createdAt: 1 },
          { id: `${id}-answer`, role: 'assistant', text: '', toolCalls: [], createdAt: 2,
            blocks: [{ id: `${id}-block`, kind: 'answer', rawText: `### ${id} review\n\nThe layout and focus behavior are ready for review.\n\n- Keep the existing conversation intact.\n- Open the selected branch alongside it.\n- Preserve the reading position when switching back.` }],
          },
        ],
      }]));
      localStorage.setItem('michi:migrated', '1');
      localStorage.setItem('michi:v1:state', JSON.stringify({
        version: 6, activeProjectId: 'reveal-ws', nodes,
        projects: [{ id: 'reveal-ws', name: 'Pane reveal', chatIds: ids,
          edges: ids.slice(1).map(target => ({ source: 'root', target, kind: 'branch' })),
          trees: [{ id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 }],
          activeTreeId: 'tree', contexts: [], createdAt: 1,
        }],
      }));
      localStorage.setItem('michi:v1:prefs', JSON.stringify({ paneWidthMode: 'adaptive', defaultPaneWidth: 800 }));
      sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'reveal-ws::tree': ['root', 'second'] }));
      sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'reveal-ws::tree': 'root' }));
    });
    await page.goto('/');
    await page.getByText('root conversation', { exact: true }).first().click();
    await assertWidths(page, 'adaptive', 2);
    for (const id of ['third', 'fourth', 'fourth']) {
      const row = page.getByRole('complementary').getByText(`${id} conversation`, { exact: true }).first();
      await expect(row).toBeVisible();
      const frames = await row.evaluate(async element => {
        const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
        const start = strip.scrollLeft;
        (element as HTMLElement).click();
        const samples: Array<{ left: number; progress: number | null }> = [];
        for (let i = 0; i < 30; i++) {
          await new Promise(requestAnimationFrame);
          samples.push({ left: strip.scrollLeft, progress: strip.getAnimations()[0]?.effect?.getComputedTiming().progress ?? null });
        }
        return { start, samples };
      });
      expect(frames.samples.some(s => s.progress !== null && s.progress < 0.9 && s.left > frames.start + 10), JSON.stringify(frames)).toBe(true);
      await assertWidths(page, 'adaptive', id === 'third' ? 3 : 4);
      const end = frames.samples.at(-1)!.left;
      expect(frames.samples.filter(s => s.progress === null).every(s => Math.abs(s.left - end) < 2)).toBe(true);
      if (id === 'fourth') {
        await page.screenshot({ path: info.outputPath('existing-chat-reveal.png') });
        await closeFocused(page);
        await assertWidths(page, 'adaptive', 3);
      }
    }
    // Reopen while the same visual slot is still retiring; its old timer must not remove it.
    await page.getByRole('complementary').getByText('fourth conversation', { exact: true }).first().click();
    await page.waitForTimeout(50);
    await closeFocused(page);
    await page.getByRole('complementary').getByText('fourth conversation', { exact: true }).first().click();
    await assertWidths(page, 'adaptive', 4);
    await page.waitForTimeout(250);
    await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
    await expect(panes(page)).toHaveCount(4);
  });

  test('rapid opens retarget smoothly and manual scrolling interrupts the reveal', async ({ page }) => {
    await installLayoutApi(page);
    await bootWithWorkspace(page);
    await page.getByRole('button', { name: 'New pane', exact: true }).click();
    await page.getByRole('button', { name: 'New pane', exact: true }).click();
    await setMode(page, 'adaptive');
    await assertWidths(page, 'adaptive', 2);
    const rapid = await page.evaluate(async () => {
      const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
      const open = () => (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
      open();
      await new Promise(resolve => setTimeout(resolve, 80));
      const before = strip.scrollLeft;
      open();
      await new Promise(requestAnimationFrame);
      const after = strip.scrollLeft;
      const samples: number[] = [];
      for (let i = 0; i < 28; i++) {
        await new Promise(requestAnimationFrame);
        samples.push(strip.scrollLeft);
      }
      return { before, after, samples };
    });
    expect(rapid.before).toBeGreaterThan(20);
    expect(Math.abs(rapid.after - rapid.before)).toBeLessThan(60);
    expect(rapid.samples.every((left, i) => i === 0 || left >= rapid.samples[i - 1] - 2)).toBe(true);
    await assertWidths(page, 'adaptive', 4);
    const interrupted = await page.evaluate(async () => {
      const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
      (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
      await new Promise(resolve => setTimeout(resolve, 80));
      strip.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -40 }));
      strip.scrollLeft -= 40;
      const stoppedAt = strip.scrollLeft;
      await new Promise(resolve => setTimeout(resolve, 500));
      return { stoppedAt, final: strip.scrollLeft };
    });
    expect(Math.abs(interrupted.final - interrupted.stoppedAt)).toBeLessThan(2);
  });

  for (const [label, suffix] of [['Phosphor Bloom', ''], ['Fission', 'Fission'], ['Thread Pull', 'ThreadPull']] as const) {
    test(`${label}: faster entrance and matching retained exit`, async ({ page }, info) => {
      await installLayoutApi(page);
      await bootWithWorkspace(page);
      await page.locator('[contenteditable="true"]').first().fill('Inspect pane animation');
      await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
      await expect(page.locator('.terminal-dashboard')).toBeVisible();
      await setMode(page, 'adaptive');
      await openSettings(page);
      await page.getByRole('combobox', { name: 'Pane animation', exact: true }).selectOption({ label });
      await page.keyboard.press('Escape');
      const entrance = await page.evaluate(async () => {
        (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
        const samples: Array<{ name: string; duration: string; scaleX: number; x: number; clip: string }> = [];
        for (let i = 0; i < 20; i++) {
          await new Promise(requestAnimationFrame);
          const el = document.querySelector<HTMLElement>('.terminal-dashboard > [data-node-id]:last-of-type')!;
          const style = getComputedStyle(el);
          const matrix = new DOMMatrixReadOnly(style.transform);
          samples.push({ name: style.animationName, duration: style.animationDuration, scaleX: matrix.a, x: matrix.e, clip: style.clipPath });
        }
        return samples;
      });
      expect(entrance.some(s => s.name === `tSpawn${suffix}` && s.duration === '0.22s')).toBe(true);
      if (label === 'Fission') {
        expect(entrance.every(s => s.scaleX <= 1.0001 && s.x <= 0.0001)).toBe(true);
      }
      if (label === 'Thread Pull') expect(entrance.some(s => s.clip !== 'none' && s.clip !== 'inset(0px 0% 0px 0px)')).toBe(true);
      await assertWidths(page, 'adaptive', 2);
      await page.screenshot({ path: info.outputPath(`${suffix || 'Phosphor'}-open.png`) });
      const exitingId = await panes(page).last().getAttribute('data-node-id');
      const samples = await page.evaluate(async () => {
        (document.activeElement as HTMLElement | null)?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
        const samples: Array<{ name: string; width: number; inert: boolean; body: number[]; caption: number[] }> = [];
        for (let i = 0; i < 24; i++) {
          await new Promise(requestAnimationFrame);
          const el = document.querySelector<HTMLElement>('.terminal-dashboard > [data-pane-exiting]');
          if (!el) continue;
          samples.push({ name: getComputedStyle(el).animationName, width: el.getBoundingClientRect().width, inert: el.inert,
            body: getComputedStyle(document.querySelector('.terminal-dashboard')!).gridTemplateColumns.split(' ').map(parseFloat),
            caption: getComputedStyle(document.querySelector('[data-pane-captions]')!).gridTemplateColumns.split(' ').map(parseFloat),
          });
        }
        return samples;
      });
      expect(samples.some(s => s.name === `tDecay${suffix}` && s.width > 1 && s.width < 550 && s.inert), JSON.stringify(samples)).toBe(true);
      expect(samples.every(s => s.body.length === s.caption.length && s.body.every((w, i) => Math.abs(w - s.caption[i]) < 2))).toBe(true);
      await expect(page.locator(`[data-node-id="${exitingId}"]`)).toHaveCount(0);
      await assertWidths(page, 'adaptive', 1);
      await info.attach('exit-frames', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
      await closeFocused(page);
      await expect(page.locator('.terminal-dashboard')).toHaveCount(0);
      await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
      await expect(page.getByRole('complementary').getByText('Mock turn', { exact: true }).first()).toBeVisible();
    });
  }
});
