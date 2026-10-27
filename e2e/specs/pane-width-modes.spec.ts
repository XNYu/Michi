import { expect, test, type Page } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR, leaveSettings, openSettings as openSettingsSection } from '../fixtures/shell';

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
  const settings = await openSettingsSection(page, 'Appearance');
  await expect(settings).toBeVisible();
  const advanced = settings.getByRole('button', { name: /Advanced/i });
  if (await advanced.getAttribute('aria-expanded') === 'false') await advanced.click();
  await expect(settings.getByRole('combobox', { name: 'Pane width mode' })).toBeVisible();
  await expect.poll(async () => {
    const box = (await settings.boundingBox())!;
    return box.x + box.width;
  }).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

async function motionCount(page: Page) {
  return page.locator('.terminal-dashboard > [data-node-id], .terminal-dashboard .pane-entry-surface, [data-pane-caption-id]')
    .evaluateAll(elements => elements.flatMap(el => el.getAnimations())
      .filter(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame || 'clipPath' in frame || 'opacity' in frame)).length);
}

async function setMode(page: Page, mode: Mode, motion?: string) {
  await openSettings(page);
  await page.getByRole('combobox', { name: 'Pane width mode' }).selectOption(mode);
  if (motion) await page.getByRole('combobox', { name: 'Pane animation', exact: true }).selectOption(motion);
  await page.getByRole('slider', { name: 'Default pane width' }).evaluate((input: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '800');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await leaveSettings(page);
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
      await page.locator(COMPOSER_EDITOR).first().fill('Compare pane layout behavior');
      await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
      await expect(page.locator('.terminal-dashboard')).toBeVisible();
      await setMode(page, mode, 'soft-fade');
      await assertWidths(page, mode, 1);

      // Text takes its final width once; WAAPI owns the pane reveal clock.
      const frames = await page.evaluate(async () => {
        (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
        await new Promise(requestAnimationFrame);
        const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
        const children = [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
        const paragraph = children[0].querySelector<HTMLElement>('.prose p')!;
        const clock = children.flatMap(el => el.getAnimations()).find(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame));
        const entrance = children.at(-1)!.querySelector('.pane-entry-surface')!.getAnimations();
        const durations = entrance.map(animation => animation.effect?.getTiming().duration);
        const samples: Array<{ body: number[]; captions: number[]; widths: number[]; textWidth: number; error: number; progress: number | null }> = [];
        for (let i = 0; i < 24; i++) {
          await new Promise(requestAnimationFrame);
          samples.push({
            body: getComputedStyle(strip).gridTemplateColumns.split(' ').map(parseFloat),
            captions: getComputedStyle(document.querySelector('[data-pane-captions]')!).gridTemplateColumns.split(' ').map(parseFloat),
            widths: children.map(el => el.getBoundingClientRect().width),
            textWidth: paragraph.getBoundingClientRect().width,
            error: Math.max(...children.map(el => Math.abs(el.getBoundingClientRect().left
              - document.querySelector(`[data-pane-caption-id="${el.dataset.nodeId}"]`)!.getBoundingClientRect().left))),
            progress: clock?.effect?.getComputedTiming().progress ?? null,
          });
        }
        return { samples, durations };
      });
      await assertWidths(page, mode, 2);
      const after = await measurements(page);
      await info.attach('layout-frames', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
      expect(frames.durations).toEqual([150]);
      expect(frames.samples.some(frame => frame.progress !== null && frame.progress > 0 && frame.progress < 1)).toBe(true);
      expect(frames.samples.every(frame => frame.widths.every((width, i) => Math.abs(width - after.widths[i]) < 1)), JSON.stringify(frames)).toBe(true);
      expect(frames.samples[0].textWidth).toBeGreaterThan(0);
      expect(frames.samples.every(frame => Math.abs(frame.textWidth - frames.samples[0].textWidth) < 1)).toBe(true);
      expect(frames.samples.every(frame => frame.error < 2 && frame.body.length === frame.captions.length
        && frame.body.every((width, i) => Math.abs(width - frame.captions[i]) < 2)), JSON.stringify(frames)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${mode}-two-panes.png`) });

      for (const count of [3, 4]) {
        const reveal = await page.evaluate(async () => {
          const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
          const captions = document.querySelector<HTMLElement>('[data-pane-captions]')!;
          const start = strip.scrollLeft;
          (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
          await new Promise(requestAnimationFrame);
          const children = [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
          const clock = children.flatMap(el => el.getAnimations()).find(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame));
          const last = children.at(-1)!;
          const samples: Array<{ scroll: number; captionScroll: number; progress: number | null; width: number; visible: number; error: number }> = [];
          for (let i = 0; i < 30; i++) {
            await new Promise(requestAnimationFrame);
            const rect = last.getBoundingClientRect();
            const viewport = strip.getBoundingClientRect();
            samples.push({
              scroll: strip.scrollLeft,
              captionScroll: -new DOMMatrixReadOnly(getComputedStyle(captions).transform).m41,
              progress: clock?.effect?.getComputedTiming().progress ?? null,
              width: rect.width,
              visible: Math.max(0, Math.min(rect.right, viewport.right) - Math.max(rect.left, viewport.left)),
              error: Math.max(...children.map(el => Math.abs(el.getBoundingClientRect().left
                - document.querySelector(`[data-pane-caption-id="${el.dataset.nodeId}"]`)!.getBoundingClientRect().left))),
            });
          }
          return { start, samples };
        });
        await assertWidths(page, mode, count);
        await info.attach(`reveal-${count}-frames`, { body: JSON.stringify(reveal, null, 2), contentType: 'application/json' });
        const final = reveal.samples.at(-1)!;
        expect(reveal.samples.some(s => s.progress !== null && s.progress > 0 && s.progress < 0.95
          && s.scroll > reveal.start + 10 && s.visible > 0 && s.visible < final.visible - 10), JSON.stringify(reveal)).toBe(true);
        expect(reveal.samples.every(s => Math.abs(s.width - final.width) < 1), JSON.stringify(reveal)).toBe(true);
        expect(reveal.samples.every(s => Math.abs(s.scroll - s.captionScroll) < 2 && s.error < 2), JSON.stringify(reveal)).toBe(true);
        expect(reveal.samples.filter(s => s.progress === null).every(s => Math.abs(s.scroll - final.scroll) < 2)).toBe(true);
      }
      await page.screenshot({ path: info.outputPath(`${mode}-four-panes.png`) });
      for (const count of [3, 2, 1]) {
        await closeFocused(page);
        await assertWidths(page, mode, count);
        await expect.poll(() => motionCount(page)).toBe(0);
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
    expect(await motionCount(page)).toBe(0);
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
    expect(await motionCount(page)).toBe(0);
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
        await new Promise(requestAnimationFrame);
        const clock = [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')]
          .flatMap(el => el.getAnimations()).find(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame));
        const samples: Array<{ left: number; progress: number | null }> = [];
        for (let i = 0; i < 30; i++) {
          await new Promise(requestAnimationFrame);
          samples.push({ left: strip.scrollLeft, progress: clock?.effect?.getComputedTiming().progress ?? null });
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

    const exerciseOpening = (action: 'retarget' | 'wheel', expectedCount: number) => page.evaluate(async ({ action, expectedCount }) => {
      const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
      const open = () => (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
      const children = () => [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
      const layoutClocks = (elements: HTMLElement[]) => elements.flatMap(element => element.getAnimations().filter(animation => {
        const effect = animation.effect;
        return effect instanceof KeyframeEffect && effect.target === element
          && effect.getKeyframes().some(frame => 'transform' in frame);
      }));
      const priorPaneIds = children().map(element => element.dataset.nodeId!);
      const priorClocks = new Set(layoutClocks(children()));
      const startScroll = strip.scrollLeft;
      const startedAt = performance.now();
      let clock: Animation | undefined;
      let frameCount = 0;
      const snapshot = () => {
        const panes = children();
        const paneIds = panes.map(element => element.dataset.nodeId!);
        clock ??= layoutClocks(panes).find(animation => !priorClocks.has(animation));
        const target = clock?.effect instanceof KeyframeEffect ? clock.effect.target : null;
        return {
          paneIds,
          newPaneIds: paneIds.filter(id => !priorPaneIds.includes(id)),
          newLayoutClock: !!clock && !priorClocks.has(clock),
          clockTargetId: target instanceof HTMLElement ? target.dataset.nodeId : null,
          clockTargetIsDirectPane: target instanceof HTMLElement && panes.includes(target),
          playState: clock?.playState ?? null,
          progress: clock?.effect?.getComputedTiming().progress ?? null,
          currentTime: clock?.currentTime ?? null,
          duration: clock?.effect?.getTiming().duration ?? null,
          startScroll,
          scrollLeft: strip.scrollLeft,
          scrollDelta: strip.scrollLeft - startScroll,
          frameCount,
          elapsedMs: performance.now() - startedAt,
        };
      };
      let stoppedAt = 0;
      open();
      const proof = await new Promise<ReturnType<typeof snapshot>>((resolve, reject) => {
        const recentFrames: ReturnType<typeof snapshot>[] = [];
        let frame = 0;
        let wallTimer = 0;
        const fail = (reason: string) => {
          cancelAnimationFrame(frame);
          clearTimeout(wallTimer);
          reject(new Error(`Opening reveal gate failed: ${JSON.stringify({ action, expectedCount, priorPaneIds, reason, recentFrames })}`));
        };
        const inspect = () => {
          frameCount++;
          const current = snapshot();
          recentFrames.push(current);
          if (recentFrames.length > 12) recentFrames.shift();
          if (frameCount >= 120 || current.elapsedMs >= 2000) {
            fail('120-frame or 2000ms observation bound reached');
            return;
          }
          if (current.playState === 'finished' || current.playState === 'idle' || (current.progress !== null && current.progress >= 0.95)) {
            fail('new layout clock passed the unfinished observation window');
            return;
          }
          if (current.paneIds.length === expectedCount && current.newPaneIds.length === 1
            && current.newLayoutClock && current.clockTargetIsDirectPane && current.playState === 'running'
            && current.progress !== null && current.progress > 0 && current.progress < 0.95 && current.scrollDelta > 20) {
            // Act in this same frame, while the observed new layout clock is unfinished.
            if (action === 'retarget') open();
            else {
              strip.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -40 }));
              strip.scrollLeft -= 40;
              stoppedAt = strip.scrollLeft;
            }
            clearTimeout(wallTimer);
            resolve(current);
            return;
          }
          frame = requestAnimationFrame(inspect);
        };
        wallTimer = window.setTimeout(() => {
          recentFrames.push(snapshot());
          fail('2000ms wall deadline reached');
        }, 2000);
        frame = requestAnimationFrame(inspect);
      });
      const before = proof.scrollLeft;
      const samples: number[] = [];
      let after = strip.scrollLeft;
      if (action === 'retarget') {
        await new Promise(requestAnimationFrame);
        after = strip.scrollLeft;
        for (let i = 0; i < 28; i++) {
          await new Promise(requestAnimationFrame);
          samples.push(strip.scrollLeft);
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return { proof, before, after, samples, stoppedAt, final: strip.scrollLeft };
    }, { action, expectedCount });
    const assertOpening = (proof: Awaited<ReturnType<typeof exerciseOpening>>['proof'], expectedCount: number) => {
      const diagnostic = JSON.stringify(proof);
      expect(proof.paneIds, diagnostic).toHaveLength(expectedCount);
      expect(proof.newPaneIds, diagnostic).toHaveLength(1);
      expect(proof.newLayoutClock, diagnostic).toBe(true);
      expect(proof.clockTargetIsDirectPane, diagnostic).toBe(true);
      expect(proof.playState, diagnostic).toBe('running');
      expect(proof.progress, diagnostic).toBeGreaterThan(0);
      expect(proof.progress, diagnostic).toBeLessThan(0.95);
      expect(proof.scrollDelta, diagnostic).toBeGreaterThan(20);
    };

    const rapid = await exerciseOpening('retarget', 3);
    assertOpening(rapid.proof, 3);
    expect(rapid.before, JSON.stringify(rapid)).toBeGreaterThan(20);
    expect(Math.abs(rapid.after - rapid.before), JSON.stringify(rapid)).toBeLessThan(60);
    expect(rapid.samples.every((left, i) => i === 0 || left >= rapid.samples[i - 1] - 2), JSON.stringify(rapid)).toBe(true);
    await assertWidths(page, 'adaptive', 4);
    const interrupted = await exerciseOpening('wheel', 5);
    assertOpening(interrupted.proof, 5);
    expect(Math.abs(interrupted.final - interrupted.stoppedAt), JSON.stringify(interrupted)).toBeLessThan(2);
  });

  for (const [label, suffix, entryX, entryY] of [['Phosphor Bloom', '', 0, 4], ['Fission', 'Fission', -12, 0], ['Thread Pull', 'ThreadPull', 16, 0]] as const) {
    test(`${label}: faster entrance and matching retained exit`, async ({ page }, info) => {
      await installLayoutApi(page);
      await bootWithWorkspace(page);
      await page.locator(COMPOSER_EDITOR).first().fill('Inspect pane animation');
      await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
      await expect(page.locator('.terminal-dashboard')).toBeVisible();
      await setMode(page, 'adaptive');
      await openSettings(page);
      await page.getByRole('combobox', { name: 'Pane animation', exact: true }).selectOption({ label });
      await leaveSettings(page);
      const entrance = await page.evaluate(async () => {
        (document.querySelector('[aria-label="New pane"]') as HTMLButtonElement).click();
        await new Promise(requestAnimationFrame);
        const el = document.querySelector<HTMLElement>('.terminal-dashboard > [data-node-id]:last-of-type')!;
        const surface = el.querySelector<HTMLElement>('.pane-entry-surface')!;
        const animations = surface.getAnimations().map(animation => ({
          duration: animation.effect?.getTiming().duration,
          frames: animation.effect!.getKeyframes().map(frame => {
            const matrix = new DOMMatrixReadOnly(String(frame.transform));
            return { x: matrix.e, y: matrix.f, scale: matrix.a, opacity: Number(frame.opacity), filter: frame.filter ?? null };
          }),
        }));
        const samples: Array<{ scaleX: number; x: number; y: number; width: number; opacity: number }> = [];
        for (let i = 0; i < 20; i++) {
          await new Promise(requestAnimationFrame);
          const style = getComputedStyle(surface);
          const matrix = new DOMMatrixReadOnly(style.transform);
          samples.push({ scaleX: matrix.a, x: matrix.e, y: matrix.f, width: el.getBoundingClientRect().width, opacity: Number(style.opacity) });
        }
        return { animations, samples };
      });
      expect(entrance.animations).toEqual([{ duration: 220, frames: [
        { x: entryX, y: entryY, scale: 1, opacity: 1, filter: null },
        { x: 0, y: 0, scale: 1, opacity: 1, filter: null },
      ] }]);
      expect(entrance.samples.every(s => s.scaleX === 1 && s.opacity === 1
        && Math.abs(s.width - entrance.samples.at(-1)!.width) < 1)).toBe(true);
      if (label === 'Fission') {
        expect(entrance.samples.some(s => s.x < 0)).toBe(true);
        expect(entrance.samples.every(s => s.x <= 0.0001)).toBe(true);
      }
      if (label === 'Thread Pull') expect(entrance.samples.some(s => s.x > 0)).toBe(true);
      if (label === 'Phosphor Bloom') expect(entrance.samples.some(s => s.y > 0)).toBe(true);
      await assertWidths(page, 'adaptive', 2);
      await page.screenshot({ path: info.outputPath(`${suffix || 'Phosphor'}-open.png`) });
      const exitingId = await panes(page).last().getAttribute('data-node-id');
      const exit = await page.evaluate(async () => {
        const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
        const el = strip.querySelector<HTMLElement>(':scope > [data-node-id]:last-of-type')!;
        const before = el.getBoundingClientRect().width;
        (document.activeElement as HTMLElement | null)?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
        await new Promise(requestAnimationFrame);
        const clocks = [...document.querySelectorAll('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')]
          .flatMap(el => el.getAnimations()).filter(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame));
        const animation = el.getAnimations().find(animation => animation.effect?.getKeyframes().some(frame => 'opacity' in frame));
        const duration = Number(animation?.effect?.getTiming().duration ?? 0);
        const keyframes = animation?.effect?.getKeyframes() ?? [];
        for (const clock of clocks) { clock.pause(); clock.currentTime = 0; }
        const samples = [];
        for (const progress of [0, .25, .5, .75, .99]) {
          for (const clock of clocks) clock.currentTime = duration * progress;
          await new Promise(requestAnimationFrame);
          samples.push({ opacity: Number(getComputedStyle(el).opacity), width: el.getBoundingClientRect().width, inert: el.inert, connected: el.isConnected,
            body: getComputedStyle(strip).gridTemplateColumns.split(' ').map(parseFloat),
            caption: getComputedStyle(document.querySelector('[data-pane-captions]')!).gridTemplateColumns.split(' ').map(parseFloat),
            error: Math.max(...[...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')].map(pane =>
              Math.abs(pane.getBoundingClientRect().left - document.querySelector(`[data-pane-caption-id="${pane.dataset.nodeId}"]`)!.getBoundingClientRect().left))),
          });
        }
        for (const clock of clocks) clock.finish();
        for (let i = 0; i < 10 && el.isConnected; i++) await new Promise(requestAnimationFrame);
        const survivor = strip.querySelector<HTMLElement>(':scope > [data-node-id]')!;
        const expansion = [...document.querySelectorAll('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')]
          .flatMap(el => el.getAnimations()).filter(animation => animation.effect?.getKeyframes().some(frame => 'clipPath' in frame));
        const expansionDurations = expansion.map(clock => clock.effect?.getTiming().duration);
        for (const clock of expansion) { clock.pause(); clock.currentTime = 0; }
        const reveal = [];
        for (const time of [0, 90, 180]) {
          for (const clock of expansion) clock.currentTime = time;
          await new Promise(requestAnimationFrame);
          const rect = survivor.getBoundingClientRect();
          const clip = getComputedStyle(survivor).clipPath.match(/-?[\d.]+px/g)?.map(parseFloat) ?? [0, 0, 0, 0];
          const caption = document.querySelector(`[data-pane-caption-id="${survivor.dataset.nodeId}"]`)!;
          reveal.push({ width: rect.width, visible: rect.width - (clip[1] ?? 0) - (clip[3] ?? 0),
            error: Math.abs(rect.left - caption.getBoundingClientRect().left), removed: !el.isConnected });
        }
        for (const clock of expansion) clock.finish();
        return { before, duration, keyframes, samples, expansionDurations, reveal, available: strip.clientWidth };
      });
      expect(exit.duration).toBe(110);
      expect(exit.keyframes.map(frame => Number(frame.opacity))).toEqual([1, 0]);
      expect(exit.samples).toHaveLength(5);
      expect(exit.samples.some(s => s.opacity > 0 && s.opacity < .8)).toBe(true);
      expect(exit.samples.every(s => s.connected && s.inert && Math.abs(s.width - exit.before) < 1 && s.error < 2
        && s.body.length === s.caption.length && s.body.every((w, i) => Math.abs(w - s.caption[i]) < 2))).toBe(true);
      expect(exit.expansionDurations.length).toBeGreaterThan(0);
      expect(exit.expansionDurations.every(duration => duration === 180)).toBe(true);
      expect(exit.reveal.every(frame => frame.removed && frame.width === exit.available && frame.error < 2)).toBe(true);
      expect(exit.reveal[0].visible).toBeCloseTo(exit.before, 1);
      expect(exit.reveal[1].visible).toBeGreaterThan(exit.reveal[0].visible);
      expect(exit.reveal[2].visible).toBe(exit.available);
      await expect(page.locator(`[data-node-id="${exitingId}"]`)).toHaveCount(0);
      await assertWidths(page, 'adaptive', 1);
      await info.attach('exit-frames', { body: JSON.stringify(exit, null, 2), contentType: 'application/json' });
      await closeFocused(page);
      await expect(page.locator('.terminal-dashboard')).toHaveCount(0);
      await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
      await expect(page.getByRole('complementary').getByText('Mock turn', { exact: true }).first()).toBeVisible();
    });
  }
});
