import { writeFile } from 'node:fs/promises';
import { test, expect } from '../fixtures/overlayDesktop';
import { bootWithWorkspace, installMockApi, sseBody } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

// Explicit benchmark, not part of routine E2E. Uses the actual production
// renderer and capturePage. Reports timings, never stores captured images.
test.skip(process.env.E2E_GLASS_PROFILE !== '1', 'Opt-in capture timing investigation');
test.setTimeout(300_000);

test('profile real desktop capture latency and lifetime', async ({ page }, info) => {
  expect(process.env.E2E_ELECTRON).toBe('1');
  expect(process.env.E2E_PRODUCTION).toBe('1');
  const metrics: any[] = [];
  page.on('console', message => {
    try {
      const row = JSON.parse(message.text());
      if (row.type === 'metric' && row.name.startsWith('glass.')) metrics.push(row);
    } catch { /* Other application logs. */ }
  });
  await installMockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem('michi:metrics', '1');
    const original = window.fetch.bind(window);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const probe = { push: (body: string) => controller.enqueue(new TextEncoder().encode(body)), timer: 0, busy: 0 };
    Object.assign(window, { glassProfile: probe });
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
  await bootWithWorkspace(page, 'Capture profile');
  await page.evaluate(size => (window as any).overlayDesktop.resize(size), {
    width: Number(process.env.E2E_GLASS_WIDTH || 1440), height: Number(process.env.E2E_GLASS_HEIGHT || 960),
  });
  const cdp = await page.context().newCDPSession(page);
  const liveImages = async (name: string) => {
    const prototype = await cdp.send('Runtime.evaluate', { expression: `${name}.prototype` });
    const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId! });
    try {
      const summary = await cdp.send('Runtime.callFunctionOn', {
        objectId: objects.objects.objectId,
        functionDeclaration: `function() { return { count: this.length, attached: this.filter(x => x.isConnected).length, pixels: this.reduce((n, x) => n + x.width * x.height, 0), dataImages: this.filter(x => x.src?.startsWith('data:image/')).length }; }`,
        returnByValue: true,
      });
      return summary.result.value;
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId! });
      await cdp.send('Runtime.releaseObject', { objectId: prototype.result.objectId! });
    }
  };
  const memory = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return {
      heap: await cdp.send('Runtime.getHeapUsage'),
      dom: await cdp.send('Memory.getDOMCounters'),
      host: await page.evaluate(() => (window as any).overlayDesktop.environment()),
      canvases: await page.locator('.ui-frozen-glass canvas').count(),
      liveCanvases: await liveImages('HTMLCanvasElement'),
      liveImages: await liveImages('HTMLImageElement'),
    };
  };
  const before = await memory();
  const blocks: any[] = [];
  const count = Number(process.env.E2E_GLASS_SAMPLES || 50);
  for (const scenario of ['idle', 'working', 'streaming', 'busy-streaming']) {
    if (scenario === 'working') {
      await page.locator(COMPOSER_EDITOR).first().fill('Synthetic timing workload');
      await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
      await page.evaluate(body => (window as any).glassProfile.push(body), sseBody([
        { event: 'chunk', data: { text: 'Working. ' } },
        { event: 'subagent_list_update', data: { subagents: [{ sessionId: 'profile-child', sessionName: 'Profile rendering', agentName: 'Explore', status: 'working', initialQuery: 'Synthetic task', group: '', dependsOn: [] }] } },
      ]));
      await expect(page.getByTestId('pane-background-work-badge')).toBeVisible();
    }
    if (scenario === 'streaming') {
      await page.evaluate(() => {
        const probe = (window as any).glassProfile;
        probe.timer = window.setInterval(() => probe.push('event: chunk\ndata: {"text":"A short streaming update. "}\n\n'), 50);
      });
    }
    if (scenario === 'busy-streaming') {
      await page.evaluate(() => {
        (window as any).glassProfile.busy = window.setInterval(() => {
          const stop = performance.now() + 8;
          while (performance.now() < stop) { /* Controlled renderer contention. */ }
        }, 16);
      });
    }
    const offset = metrics.length;
    await page.evaluate(() => (window as any).overlayDesktop.takeCaptureMetrics());
    const opens: any[] = [];
    for (let i = 0; i < count; i++) {
      const settings = i % 2 === 1;
      const trigger = settings
        ? page.getByRole('navigation', { name: 'Areas' }).locator('button[data-area="settings"]')
        : page.getByRole('button', { name: 'Search', exact: true });
      const ready = await trigger.evaluate(async (button) => {
        const start = performance.now();
        return new Promise<{ phase: string; readyMs: number }>(resolve => {
          const observer = new MutationObserver(() => {
            const panel = document.querySelector('.ui-modal-panel');
            const phase = panel?.getAttribute('data-glass');
            if (phase && phase !== 'capturing') {
              observer.disconnect();
              resolve({ phase, readyMs: performance.now() - start });
            }
          });
          observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-glass'] });
          (button as HTMLElement).click();
        });
      });
      const dialog = page.getByRole('dialog', { name: settings ? 'Settings' : 'Command palette', exact: true });
      await expect(dialog).toHaveCSS('opacity', '1');
      opens.push({ overlay: settings ? 'settings' : 'palette', ...ready });
      await page.keyboard.press('Escape');
      await expect(page.locator('.ui-modal-panel')).toHaveCount(0);
    }
    const host = await page.evaluate(() => (window as any).overlayDesktop.takeCaptureMetrics());
    blocks.push({ scenario, opens, host, metrics: metrics.slice(offset), memory: await memory() });
    console.log(`CAPTURE_PROFILE ${scenario}: ${opens.filter(row => row.phase === 'frozen').length}/${count} frozen`);
  }
  await page.evaluate(() => { clearInterval((window as any).glassProfile.timer); clearInterval((window as any).glassProfile.busy); });
  const report = { date: new Date().toISOString(), count, before, blocks, after: await memory() };
  await writeFile(info.outputPath('capture-profile.json'), JSON.stringify(report, null, 2));
});
