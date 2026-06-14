import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: './',
  optimizeDeps: {
    include: ['michi-shared'],
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
        manualChunks(id) {
          if (id.includes('node_modules/react-dom')) return 'react-vendor';
          // Keep shiki langs/themes as separate Rollup-managed dynamic chunks.
          // Only bundle shiki core+engine into markdown-code so it ships once
          // alongside the first code block render.
          if (
            id.includes('node_modules/@shikijs/langs/') ||
            id.includes('node_modules/@shikijs/themes/')
          )
            return undefined;
          if (
            id.includes('node_modules/shiki/') ||
            id.includes('node_modules/@shikijs/')
          )
            return 'markdown-code';
          if (
            id.includes('node_modules/streamdown') ||
            id.includes('node_modules/@streamdown') ||
            id.includes('node_modules/marked') ||
            id.includes('node_modules/remend') ||
            id.includes('node_modules/mermaid')
          )
            return 'markdown-streamdown';
          if (
            id.includes('node_modules/react-markdown') ||
            id.includes('node_modules/rehype') ||
            id.includes('node_modules/remark') ||
            id.includes('node_modules/unified') ||
            id.includes('node_modules/mdast') ||
            id.includes('node_modules/hast') ||
            id.includes('node_modules/micromark')
          )
            return 'markdown-legacy';
        },
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
