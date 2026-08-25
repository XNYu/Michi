import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyBrowserTheme, normalizeBrowserTheme } = require('../electron/dist/browserTheme.js');

function fakeView(attached = false) {
  const calls = [];
  return {
    calls,
    view: {
      setBackgroundColor(color) { calls.push(['background', color]); },
      webContents: {
        debugger: {
          isAttached() { return attached; },
          attach(version) { attached = true; calls.push(['attach', version]); },
          async sendCommand(method, params) { calls.push(['command', method, params]); },
        },
      },
    },
  };
}

test('normalizes Michi palette input to a safe browser theme', () => {
  assert.deepEqual(normalizeBrowserTheme(true, '#272822'), {
    colorScheme: 'dark', backgroundColor: '#272822',
  });
  assert.deepEqual(normalizeBrowserTheme(false, 'url(javascript:bad)'), {
    colorScheme: 'light', backgroundColor: '#ffffff',
  });
});

test('applies background and Chromium prefers-color-scheme emulation', async () => {
  const { view, calls } = fakeView();
  await applyBrowserTheme(view, normalizeBrowserTheme(true, '#282828'));
  assert.deepEqual(calls, [
    ['background', '#282828'],
    ['attach', '1.3'],
    ['command', 'Emulation.setEmulatedMedia', {
      media: '',
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    }],
  ]);
});

test('reuses an attached debugger when the theme changes', async () => {
  const { view, calls } = fakeView(true);
  await applyBrowserTheme(view, normalizeBrowserTheme(false, '#fdfdfc'));
  assert.equal(calls.some(([kind]) => kind === 'attach'), false);
  assert.equal(calls.at(-1)[2].features[0].value, 'light');
});
