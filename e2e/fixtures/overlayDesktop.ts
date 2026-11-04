import { test as browserTest, _electron as electron } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// Opt-in headed Electron acceptance with the same synthetic API and stream
// as the browser test. Never loads Michi's main process or a real database.
export type CaptureMode = 'success' | 'failed' | 'late' | 'missing';
const configuredTest = browserTest.extend<{ overlayCaptureMode: CaptureMode }>({
  overlayCaptureMode: ['success', { option: true }],
});
export const test = process.env.E2E_ELECTRON === '1' ? configuredTest.extend({
  page: async ({ baseURL, overlayCaptureMode }, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'michi-overlay-e2e-'));
    const app = await electron.launch({
      args: [resolve('e2e/fixtures/overlayElectron.cjs')],
      env: { ...process.env, NODE_OPTIONS: '', MICHI_OVERLAY_PROFILE: profile, MICHI_OVERLAY_CAPTURE_MODE: overlayCaptureMode },
    });
    try {
      const page = await app.firstWindow();
      // Electron's context has no configured baseURL. Match the browser
      // fixture's relative navigation while keeping requests intercepted.
      const goto = page.goto.bind(page);
      page.goto = (url, options) => goto(new URL(url, baseURL).href, options);
      await use(page);
    } finally {
      await app.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
}) : configuredTest;

export { expect } from '@playwright/test';
