import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { writeFileSync } from 'node:fs';

async function boot(page: Page, motion = 'soft-fade', count = 2, widthMode = 'adaptive') {
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent-runs') { await route.fulfill({ json: { runs: [] } }); return true; }
    if (path === '/api/agent-runs/subscribe') {
      await route.fulfill({ contentType: 'text/event-stream', body: ': keepalive\n\n' }); return true;
    }
    return false;
  } });
  await page.addInitScript(({ motion, count, widthMode }) => {
    localStorage.clear(); sessionStorage.clear();
    const ids = ['root', 'second', 'third', 'fourth'];
    const paragraph = 'A quiet workspace preserves the reading position and the shape of every paragraph. Pane changes should keep code readable and apply the final text width once, without squeezing words through intermediate columns.';
    const answer = Array.from({ length: 30 }, (_, i) => `### Section ${i + 1}\n\n${paragraph}\n\n\`\`\`typescript\nconst pane = { width: 800, index: ${i} };\nconst result = items.map(item => ({ ...item, pane }));\n\`\`\`\n\n${paragraph}`).join('\n\n');
    const nodes = Object.fromEntries(ids.map(id => [id, {
      nodeId: id, kind: 'chat', chatId: null, projectId: 'motion-ws', title: `${id} conversation`, status: 'idle', followUps: [],
      messages: [
        { id: `${id}-q`, role: 'user', text: 'Review the pane motion.', toolCalls: [], createdAt: 1 },
        { id: `${id}-a`, role: 'assistant', text: '', toolCalls: [], createdAt: 2,
          blocks: [{ id: `${id}-block`, kind: 'answer', rawText: answer }] },
      ],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'motion-ws', nodes, projects: [{
      id: 'motion-ws', name: 'Pane motion measurement', chatIds: ids,
      edges: ids.slice(1).map(target => ({ source: 'root', target, kind: 'branch' })),
      trees: [{ id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 }], activeTreeId: 'tree', contexts: [], createdAt: 1,
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ paneSpawnAnimation: motion, paneWidthMode: widthMode, defaultPaneWidth: 800, singlePaneContentWidth: null }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'motion-ws::tree': ids.slice(0, count) }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'motion-ws::tree': 'root' }));
  }, { motion, count, widthMode });
  await page.goto('/');
  await page.getByText('root conversation', { exact: true }).first().click();
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(count);
  await expect(page.locator('.terminal-dashboard .prose p').first()).toBeAttached();
  await page.waitForTimeout(700);
}

async function sample(page: Page, action: 'open' | 'close', count: number) {
  return page.evaluate(async ({ action, count }) => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    // Only a single known paragraph is observed, never all transcript descendants.
    const paragraph = strip.querySelector<HTMLElement>('[data-msg-id="root-a"] .prose p')!;
    const initial = paragraph.getBoundingClientRect().width;
    const start = performance.now();
    let previousTime = start;
    if (action === 'open') {
      const row = [...document.querySelectorAll<HTMLElement>('aside *')].find(el => el.textContent === `${count === 1 ? 'second' : 'third'} conversation`);
      row!.click();
    } else {
      (document.activeElement as HTMLElement)?.blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    }
    const frames = [];
    for (let i = 0; i < 36; i++) {
      await new Promise(requestAnimationFrame);
      const time = performance.now();
      const panes = [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
      const error = Math.max(...panes.map(pane => {
        const caption = document.querySelector<HTMLElement>(`[data-pane-caption-id="${pane.dataset.nodeId}"]`)!;
        return Math.abs(pane.getBoundingClientRect().left - caption.getBoundingClientRect().left);
      }));
      frames.push({ time: time - start, delta: time - previousTime, width: paragraph.getBoundingClientRect().width, scroll: strip.scrollLeft, error,
        widths: panes.map(pane => pane.getBoundingClientRect().width),
        scale: panes.map(pane => new DOMMatrixReadOnly(getComputedStyle(pane).transform).a),
      });
      previousTime = time;
    }
    return { initial, frames, changes: frames.filter((f, i) => Math.abs(f.width - (i ? frames[i - 1].width : initial)) > .1).length };
  }, { action, count });
}

test.use({ viewport: { width: 1480, height: 1000 } });

for (const width of [1480, 390]) for (const id of ['root', 'second']) {
  test(`sequential 2->1 closes ${id} before fullscreen at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page, 'soft-fade', 2);
    await page.locator(`[data-pane-caption-id="${id}"]`).evaluate(el => (el as HTMLElement).click());
    await page.waitForTimeout(300);
    const scene = await page.evaluateHandle(async id => {
      const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
      const outgoing = strip.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
      const survivor = strip.querySelector<HTMLElement>(`[data-node-id="${id === 'root' ? 'second' : 'root'}"]`)!;
      const paragraph = survivor.querySelector<HTMLElement>('.prose p')!;
      const before = { left: survivor.getBoundingClientRect().left, width: survivor.offsetWidth,
        textWidth: paragraph.offsetWidth, scroll: strip.scrollLeft };
      document.querySelector<HTMLElement>(`[aria-label="Close ${id} conversation"]`)!.click();
      await new Promise(requestAnimationFrame);
      const animations = [...document.querySelectorAll('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')]
        .flatMap(el => el.getAnimations()).filter(a => a.effect?.getKeyframes().some(f => 'transform' in f));
      for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
      return { strip, outgoing, survivor, paragraph, before, animations };
    }, id);
    for (const time of [0, 55, 110]) {
      const frame = await scene.evaluate(async (scene, time) => {
        for (const animation of scene.animations) animation.currentTime = time;
        await new Promise(requestAnimationFrame);
        return { connected: scene.outgoing.isConnected, opacity: Number(getComputedStyle(scene.outgoing).opacity),
          left: scene.survivor.getBoundingClientRect().left, width: scene.survivor.offsetWidth,
          textWidth: scene.paragraph.offsetWidth, scroll: scene.strip.scrollLeft, before: scene.before };
      }, time);
      expect(frame.connected).toBe(true);
      expect(frame.width).toBe(frame.before.width);
      expect(frame.textWidth).toBe(frame.before.textWidth);
      expect(Math.abs(frame.left - frame.before.left)).toBeLessThan(1);
      expect(frame.scroll).toBe(frame.before.scroll);
      if (time === 110) expect(frame.opacity).toBe(0);
    }
    await page.screenshot({ path: info.outputPath('closed-before-expansion.png') });
    await scene.evaluate(async scene => {
      for (const animation of scene.animations) animation.finish();
      for (let i = 0; i < 10 && scene.outgoing.isConnected; i++) await new Promise(requestAnimationFrame);
      scene.animations = [...document.querySelectorAll('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')]
        .flatMap(el => el.getAnimations()).filter(a => a.effect?.getKeyframes().some(f => 'transform' in f));
      for (const animation of scene.animations) { animation.pause(); animation.currentTime = 0; }
    });
    const widths = [];
    for (const time of [0, 90, 180]) {
      const frame = await scene.evaluate(async (scene, time) => {
        for (const animation of scene.animations) animation.currentTime = time;
        await new Promise(requestAnimationFrame);
        const clip = getComputedStyle(scene.survivor).clipPath.match(/-?[\d.]+px/g)?.map(parseFloat) ?? [0];
        const caption = document.querySelector(`[data-pane-caption-id="${scene.survivor.dataset.nodeId}"]`)!;
        return { connected: scene.outgoing.isConnected, width: scene.survivor.offsetWidth,
          visible: scene.survivor.offsetWidth - (clip[1] ?? 0) - (clip[3] ?? 0), initial: scene.before.width,
          error: Math.abs(scene.survivor.getBoundingClientRect().left - caption.getBoundingClientRect().left),
          viewport: scene.strip.clientWidth };
      }, time);
      expect(frame.connected).toBe(false);
      expect(frame.error).toBeLessThan(2);
      expect(frame.width).toBe(frame.viewport);
      if (time === 0) expect(frame.visible).toBe(frame.initial);
      if (time === 180) expect(frame.visible).toBe(frame.viewport);
      widths.push(frame.visible);
      await page.screenshot({ path: info.outputPath(`expansion-${time}.png`) });
    }
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(widths[2]).toBeGreaterThan(widths[1]);
    await scene.evaluate(scene => { for (const animation of scene.animations) animation.finish(); });
    await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(1);
    await scene.dispose();
  });
}

for (const scenario of [
  { count: 3, id: 'third', width: 1480 },
  { count: 4, id: 'fourth', width: 1480 },
  { count: 4, id: 'second', width: 1480 },
]) test(`single cover ${scenario.count} panes closing ${scenario.id} at ${scenario.width}px has no removal edge`, async ({ page }, info) => {
  await page.setViewportSize({ width: scenario.width, height: 900 });
  await boot(page, 'soft-fade', scenario.count);
  await page.locator(`[data-pane-caption-id="${scenario.id}"]`).evaluate(el => (el as HTMLElement).click());
  await page.waitForTimeout(300);
  const scene = await page.evaluateHandle(async id => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    const outgoing = strip.querySelector<HTMLElement>(`:scope > [data-node-id="${id}"]`)!;
    const body = outgoing.querySelector<HTMLElement>('.terminal-pane')!;
    const caption = document.querySelector<HTMLElement>(`[data-pane-caption-id="${id}"]`)!;
    const before = { width: outgoing.offsetWidth, opacity: getComputedStyle(body).opacity, filter: getComputedStyle(body).filter,
      captionFilter: getComputedStyle(caption).filter };
    (document.activeElement as HTMLElement)?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(requestAnimationFrame);
    const animations = [...document.querySelectorAll<HTMLElement>('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')]
      .flatMap(el => el.getAnimations({ subtree: true }));
    for (const animation of animations) { animation.pause(); animation.currentTime = 0; }
    return { strip, outgoing, body, before, animations };
  }, scenario.id);
  const frames = [];
  for (const time of [0, 40, 80, 120, 159, 160]) {
    frames.push(await scene.evaluate(async (scene, time) => {
      for (const animation of scene.animations) animation.currentTime = time;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const style = getComputedStyle(scene.outgoing);
      const clip = style.clipPath.match(/-?[\d.]+px/g)?.map(parseFloat) ?? [0];
      const panes = [...scene.strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
      return { time, connected: scene.outgoing.isConnected, width: scene.outgoing.offsetWidth,
        opacity: getComputedStyle(scene.outgoing.querySelector('.pane-entry-surface')!).opacity,
        bodyOpacity: getComputedStyle(scene.body).opacity, bodyFilter: getComputedStyle(scene.body).filter,
        before: scene.before, paintedWidth: Math.max(0, scene.outgoing.offsetWidth - (clip[1] ?? clip[0]) - (clip[3] ?? clip[1] ?? clip[0])),
        captionOpacity: getComputedStyle(document.querySelector(`[data-pane-caption-id="${scene.outgoing.dataset.nodeId}"]`)!).opacity,
        captionFilter: getComputedStyle(document.querySelector(`[data-pane-caption-id="${scene.outgoing.dataset.nodeId}"]`)!).filter,
        error: Math.max(...panes.map(pane => Math.abs(pane.getBoundingClientRect().left - document.querySelector(`[data-pane-caption-id="${pane.dataset.nodeId}"]`)!.getBoundingClientRect().left))),
        survivors: panes.filter(p => p !== scene.outgoing).map(p => ({ id: p.dataset.nodeId, left: p.getBoundingClientRect().left, width: p.offsetWidth })),
      };
    }, time));
    if (time === 80 || time === 160) await page.screenshot({ path: info.outputPath(`cover-${time}.png`) });
  }
  await info.attach('cover-steps', { body: JSON.stringify(frames, null, 2), contentType: 'application/json' });
  writeFileSync(info.outputPath('cover-steps.json'), JSON.stringify(frames, null, 2));
  expect(frames.every(f => f.connected && f.width === f.before.width && f.opacity === '1' && f.captionOpacity === '1'
    && f.bodyOpacity === f.before.opacity && f.bodyFilter === f.before.filter && f.captionFilter === f.before.captionFilter && f.error < 2), JSON.stringify(frames)).toBe(true);
  expect(frames[0].paintedWidth).toBeGreaterThan(0);
  expect(frames.at(-1)!.paintedWidth).toBe(0);
  // A paused completed visual stays retained until the actual finish signal.
  await page.waitForTimeout(250);
  expect(await scene.evaluate(scene => scene.outgoing.isConnected)).toBe(true);
  await scene.evaluate(scene => { for (const animation of scene.animations) animation.finish(); });
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(scenario.count - 1);
  await page.waitForTimeout(50);
  const after = await page.locator('.terminal-dashboard > [data-node-id]').evaluateAll(panes => panes.map(p => ({
    id: (p as HTMLElement).dataset.nodeId, left: p.getBoundingClientRect().left, width: (p as HTMLElement).offsetWidth,
  })));
  expect(after.map(p => p.id)).toEqual(frames.at(-1)!.survivors.map(p => p.id));
  expect(after.every((p, i) => Math.abs(p.left - frames.at(-1)!.survivors[i].left) < 1 && p.width === frames.at(-1)!.survivors[i].width)).toBe(true);
  await page.screenshot({ path: info.outputPath('cover-removed.png') });
  await scene.dispose();
});

for (const count of [1, 2]) test(`long transcript ${count}->${count + 1} layout measurement and scrolled caption alignment`, async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page, 'soft-fade', count);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const results = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const action of ['open', 'close'] as const) {
      await page.locator('.terminal-dashboard > [data-node-id="root"] .term-scrollbar').first().evaluate(async el => {
        el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
        el.scrollTop = 0;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      const before = await metrics();
      if (process.env.PANE_CPU_PROFILE === '1') {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.start');
      }
      const sampled = await sample(page, action, count);
      if (process.env.PANE_CPU_PROFILE === '1') {
        const { profile } = await cdp.send('Profiler.stop');
        writeFileSync(info.outputPath(`${action}-${repeat}.cpuprofile`), JSON.stringify(profile));
      }
      expect(sampled.initial).toBeGreaterThan(100);
      const after = await metrics();
      const result = { repeat, action, widthChanges: sampled.changes,
        firstFrameMs: sampled.frames[0].time,
        maxFrameMs: Math.max(...sampled.frames.map(f => f.delta)),
        framesOver33: sampled.frames.filter(f => f.delta > 33.4).length,
        layoutCount: after.LayoutCount - before.LayoutCount,
        layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
        maxCaptionError: Math.max(...sampled.frames.map(f => f.error)), frames: sampled.frames };
      results.push(result);
      if (process.env.PANE_MOTION_BASELINE !== '1') {
        expect(result.widthChanges).toBeLessThanOrEqual(1);
        expect(result.maxCaptionError).toBeLessThan(2);
        expect(sampled.frames.every(f => f.scale.every(scale => Math.abs(scale - 1) < .001))).toBe(true);
      }
    }
  }
  await info.attach('motion-metrics', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  writeFileSync(info.outputPath('metrics.json'), JSON.stringify(results, null, 2));
  console.log('PANE_METRICS', JSON.stringify(results.map(({ frames: _frames, ...metrics }) => metrics)));
  await page.screenshot({ path: info.outputPath('desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await expect(page.locator('.terminal-dashboard')).toBeVisible();
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath('mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('rapid retarget, user interruption, reopen and reduced motion', async ({ page }) => {
  await boot(page, 'gentle-glide');
  const result = await page.evaluate(async () => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    const open = () => (document.querySelector('[aria-label="New pane"]') as HTMLElement).click();
    open();
    await new Promise(resolve => setTimeout(resolve, 70));
    const before = strip.scrollLeft;
    open();
    await new Promise(requestAnimationFrame);
    const after = strip.scrollLeft;
    await new Promise(resolve => setTimeout(resolve, 50));
    strip.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: -40 }));
    strip.scrollLeft -= 40;
    const stopped = strip.scrollLeft;
    await new Promise(resolve => setTimeout(resolve, 400));
    return { before, after, stopped, final: strip.scrollLeft };
  });
  expect(result.before).toBeGreaterThan(20);
  expect(Math.abs(result.after - result.before)).toBeLessThan(100);
  expect(Math.abs(result.final - result.stopped)).toBeLessThan(2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'New pane', exact: true }).click();
  expect(await page.locator('.terminal-dashboard').evaluate(el => el.getAnimations({ subtree: true }).filter(a => a.effect?.getKeyframes().some(f => 'transform' in f)).length)).toBe(0);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true })));
  await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
});

for (const interruption of ['close-again', 'reopen', 'resize', 'reduced-motion'] as const) {
  test(`claimed close is released after ${interruption}`, async ({ page }) => {
    await boot(page, 'soft-fade', 4);
    await page.locator('[data-pane-caption-id="fourth"]').evaluate(el => (el as HTMLElement).click());
    await page.evaluate(async () => {
      (document.activeElement as HTMLElement)?.blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
      await new Promise(requestAnimationFrame);
      for (const el of document.querySelectorAll('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')) {
        for (const animation of el.getAnimations()) {
          if (!animation.effect?.getKeyframes().some(frame => 'transform' in frame)) continue;
          animation.pause(); animation.currentTime = 60;
        }
      }
    });
    await page.waitForTimeout(250);
    await expect(page.locator('.terminal-dashboard > [data-pane-exiting]')).toHaveCount(1);
    if (interruption === 'close-again') {
      await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true })));
    } else if (interruption === 'reopen') {
      await page.getByRole('complementary').getByText('fourth conversation', { exact: true }).first().click();
    } else {
      if (interruption === 'reduced-motion') await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1300, height: 850 });
    }
    const count = interruption === 'close-again' ? 2 : interruption === 'reopen' ? 4 : 3;
    await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(count);
    await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
    await expect.poll(() => page.locator('.terminal-dashboard > [data-node-id], [data-pane-caption-id], .pane-entry-surface')
      .evaluateAll(elements => elements.flatMap(el => el.getAnimations())
        .filter(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame)).length)).toBe(0);
    expect(await page.locator('.terminal-dashboard > [data-node-id]').evaluateAll(panes => panes.every(pane =>
      getComputedStyle(pane).clipPath === 'none' && getComputedStyle(pane).transform === 'none'))).toBe(true);
  });
}

for (const native of [true, false]) test(`scrolled middle close reveals its predecessor and retains vertical reading position (${native ? 'native' : 'fallback'})`, async ({ page }) => {
  if (!native) await page.addInitScript(() => Object.defineProperty(window, 'ScrollTimeline', { value: undefined }));
  await boot(page, 'soft-fade', 4);
  const result = await page.evaluate(async () => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    const caption = document.querySelector<HTMLElement>('[data-pane-caption-id="second"]')!;
    caption.click();
    await new Promise(requestAnimationFrame);
    strip.scrollLeft = 550;
    const scroller = strip.querySelector<HTMLElement>('[data-node-id="root"] .term-scrollbar')!;
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -100 }));
    scroller.scrollTop = 100;
    await new Promise(requestAnimationFrame);
    const before = { left: strip.scrollLeft, top: scroller.scrollTop };
    (document.activeElement as HTMLElement)?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    const frames = [];
    for (let i = 0; i < 24; i++) {
      await new Promise(requestAnimationFrame);
      const panes = [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
      const painted = panes.filter(pane => !pane.hasAttribute('data-pane-exiting')).map(pane => {
        const rect = pane.getBoundingClientRect();
        const clip = getComputedStyle(pane).clipPath.match(/-?[\d.]+px/g)?.map(parseFloat);
        return { left: rect.left + (clip?.[3] ?? clip?.[1] ?? 0), right: rect.right - (clip?.[1] ?? 0) };
      }).filter(rect => rect.right > rect.left);
      frames.push({ left: strip.scrollLeft, top: scroller.scrollTop,
        overlap: painted.some((rect, i) => i > 0 && painted[i - 1].right > rect.left + 1),
        error: Math.max(...panes.map(pane => Math.abs(pane.getBoundingClientRect().left
          - document.querySelector(`[data-pane-caption-id="${pane.dataset.nodeId}"]`)!.getBoundingClientRect().left))),
      });
    }
    return { before, frames };
  });
  expect(result.before.top).toBeGreaterThan(0);
  expect(result.frames.every(f => !f.overlap && f.error < 2 && Math.abs(f.top - result.before.top) < 2), JSON.stringify(result)).toBe(true);
  expect(result.frames.at(-1)!.left).toBeLessThan(result.before.left);
  await page.getByRole('complementary').getByText('second conversation', { exact: true }).first().click();
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(4);
  await page.waitForTimeout(260);
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(4);
});

for (const motion of ['soft-fade', 'gentle-glide', 'frozen-retract', 'phosphor', 'fission', 'thread-pull']) {
  test(`${motion} entrance, close/reopen and last-pane behavior`, async ({ page }) => {
    await boot(page, motion, 1);
    const frames = await page.getByRole('complementary').getByText('second conversation', { exact: true }).first().evaluate(async el => {
      (el as HTMLElement).click();
      await new Promise(requestAnimationFrame);
      const pane = document.querySelector<HTMLElement>('.terminal-dashboard > [data-node-id="second"]')!;
      const surface = pane.querySelector<HTMLElement>('.pane-entry-surface')!;
      const animations = surface.getAnimations();
      return animations.map(animation => ({ duration: animation.effect?.getTiming().duration, frames: (animation.effect as KeyframeEffect).getKeyframes(), width: pane.getBoundingClientRect().width }));
    });
    expect(frames).toHaveLength(1);
    expect(Number(frames[0].duration)).toBeLessThanOrEqual(220);
    expect(frames[0].width).toBe(600);
    expect(frames[0].frames.every(f => !String(f.transform).includes('scale') && f.filter === undefined)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true })));
    await page.getByRole('complementary').getByText('second conversation', { exact: true }).first().click();
    await page.waitForTimeout(240);
    await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(2);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true })));
    await expect(page.locator('.terminal-dashboard')).toHaveCount(0);
  });
}

for (const count of [1, 2]) test(`closing ${count} panes preserves outgoing transcript geometry`, async ({ page }, info) => {
  await boot(page, 'soft-fade', count);
  const result = await page.evaluate(async () => {
    const pane = document.querySelector<HTMLElement>('.terminal-dashboard > [data-node-id="root"]')!;
    const surface = pane.querySelector<HTMLElement>('.pane-entry-surface')!;
    const paragraph = pane.querySelector<HTMLElement>('[data-msg-id="root-a"] .prose p')!;
    const sibling = document.querySelector<HTMLElement>('.terminal-dashboard > [data-node-id="second"]');
    const siblingLeft = sibling?.getBoundingClientRect().left ?? 0;
    const before = { width: pane.offsetWidth, paragraphWidth: paragraph.offsetWidth, paragraphHeight: paragraph.offsetHeight };
    (document.activeElement as HTMLElement)?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    const frames = [];
    for (let i = 0; i < 24; i++) {
      await new Promise(requestAnimationFrame);
      if (!pane.isConnected) continue;
      frames.push({ opacity: Number(getComputedStyle(surface).opacity), inert: pane.inert,
        clip: getComputedStyle(pane).clipPath,
        siblingMovement: siblingLeft - (sibling?.getBoundingClientRect().left ?? 0),
        width: pane.offsetWidth, paragraphWidth: paragraph.offsetWidth, paragraphHeight: paragraph.offsetHeight,
        caption: !!document.querySelector('[data-pane-caption-id="root"]') });
    }
    return { before, frames };
  });
  await info.attach('exit-frames', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.frames.length).toBeGreaterThan(2);
  expect(result.frames.every(frame => frame.opacity === 1)).toBe(true);
  if (count === 1) expect(result.frames.some(frame => frame.clip !== 'none')).toBe(true);
  if (count > 1) expect(result.frames.every(frame => Math.abs(frame.siblingMovement) < 1)).toBe(true);
  expect(result.frames.every(frame => frame.inert && frame.caption && frame.width === result.before.width
    && frame.paragraphWidth === result.before.paragraphWidth && frame.paragraphHeight === result.before.paragraphHeight)).toBe(true);
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(count - 1);
});

for (const count of [4]) test(`closing the last of ${count} panes reveals its neighbour during the exit`, async ({ page }, info) => {
  await boot(page, 'soft-fade', count);
  const result = await page.evaluate(async count => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    const panes = [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
    const outgoing = panes.at(-1)!;
    const survivor = panes.at(-2)!;
    document.querySelector<HTMLElement>(`[data-pane-caption-id="${outgoing.dataset.nodeId}"]`)!.click();
    await new Promise(resolve => setTimeout(resolve, 260));
    if (count > 2) strip.scrollLeft = strip.scrollWidth - strip.clientWidth;
    await new Promise(requestAnimationFrame);
    const before = { scroll: strip.scrollLeft, survivorWidth: survivor.offsetWidth, outgoingWidth: outgoing.offsetWidth };
    const startedAt = performance.now();
    (document.activeElement as HTMLElement)?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    const frames = [];
    for (let i = 0; i < 24; i++) {
      await new Promise(requestAnimationFrame);
      const clip = getComputedStyle(survivor).clipPath.match(/-?[\d.]+px/g)?.map(parseFloat);
      frames.push({ time: performance.now() - startedAt, connected: outgoing.isConnected, opacity: Number(getComputedStyle(outgoing.querySelector('.pane-entry-surface')!).opacity),
        progress: outgoing.getAnimations()[0]?.effect?.getComputedTiming().progress ?? 1,
        outgoingWidth: outgoing.offsetWidth, scroll: strip.scrollLeft,
        paintedWidth: survivor.offsetWidth - (clip?.[1] ?? 0) - (clip?.[3] ?? clip?.[1] ?? 0),
        animations: survivor.getAnimations().length,
      });
    }
    return { before, frames };
  }, count);
  await info.attach('concurrent-last-close', { body: JSON.stringify(result), contentType: 'application/json' });
  writeFileSync(info.outputPath('concurrent-last-close.json'), JSON.stringify(result, null, 2));
  const during = result.frames.filter(frame => frame.connected && frame.progress > 0 && frame.progress < 1);
  expect(during.length, JSON.stringify(result)).toBeGreaterThan(1);
  expect(during.every(frame => frame.outgoingWidth === result.before.outgoingWidth)).toBe(true);
  expect(during.every(frame => frame.opacity === 1)).toBe(true);
  expect(during.some(frame => count === 2 ? frame.paintedWidth > result.before.survivorWidth + 10
    : frame.scroll < result.before.scroll - 10)).toBe(true);
  const distance = result.before.scroll - result.frames.at(-1)!.scroll;
  expect(result.frames.filter(frame => frame.connected).every(frame =>
    result.before.scroll - frame.scroll <= distance * frame.progress + 4), JSON.stringify(result)).toBe(true);
  expect(result.frames.at(-1)?.animations).toBe(0);
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(count - 1);
});

for (const width of [1480, 390]) test(`mid-motion surfaces remain disjoint at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await boot(page, 'gentle-glide', 3);
  const result = await page.evaluate(async () => {
    const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
    // Close the first pane; the survivors must slide without scaling or overlap.
    (document.activeElement as HTMLElement)?.blur();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(requestAnimationFrame);
    const panes = [...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')];
    for (const pane of [...panes, ...document.querySelectorAll<HTMLElement>('[data-pane-caption-id]')]) {
      for (const animation of pane.getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = 65; }
    }
    return panes.filter(pane => !pane.hasAttribute('data-pane-exiting')).map(pane => {
      const rect = pane.getBoundingClientRect();
      const style = getComputedStyle(pane);
      const clip = style.clipPath.match(/-?[\d.]+px/g)?.map(parseFloat);
      return { left: rect.left + (clip?.[3] ?? clip?.[1] ?? 0), right: rect.right - (clip?.[1] ?? 0),
        scale: new DOMMatrixReadOnly(style.transform).a };
    }).filter(rect => rect.right > rect.left);
  });
  expect(result.every((rect, i) => rect.scale === 1 && (i === 0 || result[i - 1].right <= rect.left + 1))).toBe(true);
  await page.screenshot({ path: info.outputPath(`mid-motion-${width}.png`) });
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')) {
      for (const animation of el.getAnimations({ subtree: true })) animation.finish();
    }
  });
});

for (const mode of ['fixed', 'half', 'adaptive']) test(`${mode} sizing, immediate manual resize and custom width preservation`, async ({ page }) => {
  await boot(page, 'soft-fade', 2, mode);
  const panes = page.locator('.terminal-dashboard > [data-node-id]');
  await expect.poll(() => panes.first().evaluate(el => el.getBoundingClientRect().width)).toBe(mode === 'fixed' ? 800 : 600);
  const handle = panes.first().getByTitle('Drag to resize · Double-click to reset');
  const box = (await handle.boundingBox())!;
  const before = await panes.first().evaluate(el => el.getBoundingClientRect().width);
  await page.mouse.move(box.x + 4, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x - 76, box.y + 180, { steps: 4 });
  await expect.poll(() => panes.first().evaluate(el => el.getBoundingClientRect().width)).toBe(before - 80);
  expect(await panes.first().evaluate(el => el.getAnimations().length)).toBe(0);
  await page.mouse.up();
  await page.getByRole('complementary').getByText('third conversation', { exact: true }).first().click();
  await expect(panes).toHaveCount(3);
  await expect.poll(() => panes.first().evaluate(el => el.getBoundingClientRect().width)).toBe(before - 80);
  await expect.poll(() => panes.last().evaluate(el => el.getBoundingClientRect().width)).toBe(mode === 'half' ? 600 : 800);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => panes.last().evaluate(el => el.getBoundingClientRect().width)).toBe(mode === 'half' ? 195 : 390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
