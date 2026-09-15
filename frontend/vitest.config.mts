import { availableParallelism } from 'node:os';
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.mts';

// These .ts tests still exercise React hooks or window.localStorage.
// Everything outside the audited logic directories stays in jsdom by default.
const domStateTests = [
  'chatReducers.digest',
  'digestOrchestration',
  'manageRoute',
  'navHistory',
  'perWindowActiveProject',
  'usePanePresenceIntegration',
  'usePanePresenceReporter',
  'workspacePersistence.scoped',
];
const nodeTests = [
  `src/state/!(${domStateTests.join('|')}).test.ts`,
  'src/lib/!(threadRowContextMenu).test.ts',
  'viteChunks.test.ts',
];
const commonTest = { globals: true, css: false, isolate: true };

export default mergeConfig(viteConfig, defineConfig({
  test: {
    ...commonTest,
    // Keep this limit only at the root so --maxWorkers can override it.
    maxWorkers: Math.min(4, availableParallelism()),
    forceRerunTriggers: [...configDefaults.forceRerunTriggers, '**/src/setupTests.ts'],
    projects: [
      {
        extends: './vite.config.mts',
        test: {
          ...commonTest,
          name: 'node',
          include: nodeTests,
          environment: 'node',
          pool: 'threads',
        },
      },
      {
        extends: './vite.config.mts',
        test: {
          ...commonTest,
          name: 'dom',
          exclude: [...configDefaults.exclude, ...nodeTests],
          environment: 'jsdom',
          pool: 'forks',
          setupFiles: ['./src/setupTests.ts'],
        },
      },
    ],
  },
}));
