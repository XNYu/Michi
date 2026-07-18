import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { frontendManualChunk } from './viteChunks';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: './',
  resolve: {
    // This is a linked workspace package, not an immutable npm dependency.
    // Resolve its source directly so new exports cannot be hidden behind a
    // stale Vite optimized-dependency cache.
    alias: {
      'michi-shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['michi-shared'],
  },
  server: {
    port: 3001,
    strictPort: true,
  },
  build: {
    outDir: 'build',
    target: 'es2022',
    cssTarget: 'chrome120',
    sourcemap: false,
    emptyOutDir: true,
    reportCompressedSize: false,
    commonjsOptions: {
      include: [/node_modules/, /shared\/dist/],
    },
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter((dep) => !dep.includes('markdown-streamdown') && !dep.includes('markdown-code'));
      },
    },
    rollupOptions: {
      output: {
        manualChunks: frontendManualChunk,
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    css: false,
  },
});
