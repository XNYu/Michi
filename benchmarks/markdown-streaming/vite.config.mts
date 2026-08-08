import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const rootNodeModules = fileURLToPath(new URL('../../node_modules/', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${rootNodeModules}react/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${rootNodeModules}react/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${rootNodeModules}react/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: `${rootNodeModules}react-dom/index.js` },
      { find: /^react-dom\/client$/, replacement: `${rootNodeModules}react-dom/client.js` },
    ],
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
  build: {
    target: 'es2022',
    cssTarget: 'chrome120',
  },
});
