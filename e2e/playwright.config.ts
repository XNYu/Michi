import { defineConfig, devices } from '@playwright/test';

// Web-only e2e for the React/Vite frontend. The backend is NEVER reached —
// every /api/** call is intercepted by fixtures/mockApi.ts. That keeps tests
// hermetic (no kiro-cli binary, no external auth, no sqlite).
//
// Run from repo root:
//   npm run test:e2e               # headless, all specs
//   npm run test:e2e -- --ui       # interactive UI
//   npm run test:e2e -- --debug    # step debugger
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',

  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Keep videos off by default — they bloat traces. Enable per-spec when debugging.
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Reuse a running dev server if one is already up (port 3001). Otherwise
  // boot vite from the frontend workspace. We do NOT start the backend — the
  // mockApi fixture intercepts every /api/** call.
  webServer: {
    command: 'npm run frontend:dev',
    cwd: '..',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
