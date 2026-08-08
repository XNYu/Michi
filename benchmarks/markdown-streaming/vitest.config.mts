import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Streamdown's local benchmark install carries React 19. Keep the unit-test
// renderer on that same copy; the browser benchmark separately aliases all
// React imports to the app's React 18 runtime in vite.config.mts.
const testNodeModules = fileURLToPath(new URL('./node_modules/', import.meta.url));

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: `${testNodeModules}react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${testNodeModules}react/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${testNodeModules}react/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: `${testNodeModules}react-dom/index.js` },
      { find: /^react-dom\/client$/, replacement: `${testNodeModules}react-dom/client.js` },
    ],
  },
  test: {
    environment: 'jsdom',
    server: {
      deps: {
        inline: [/^streamdown$/],
      },
    },
  },
});
