import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { frontendManualChunk } from './viteChunks';

const packageRequire = createRequire(import.meta.url);
const fontAssetDirectories = ['@fontsource/geist', '@fontsource/geist-mono', '@fontsource/ibm-plex-mono']
  .map(name => dirname(packageRequire.resolve(`${name}/package.json`)));

function restrictedRuntimeBuildFlag(): string {
  return process.env.VITE_MICHI_RESTRICTED_RUNTIMES ?? '0';
}

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: './',
  define: {
    'import.meta.env.VITE_MICHI_RESTRICTED_RUNTIMES': JSON.stringify(restrictedRuntimeBuildFlag()),
  },
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
    // A worktree can link individual font packages to the primary checkout.
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url)), ...fontAssetDirectories] },
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
});
