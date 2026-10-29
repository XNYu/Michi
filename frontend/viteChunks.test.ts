import { describe, expect, it } from 'vitest';
import { frontendManualChunk } from './viteChunks';

describe('frontendManualChunk', () => {
  it('does not bundle the synchronous streaming lexer with the diagram engine', () => {
    expect(frontendManualChunk('/repo/node_modules/marked/lib/marked.esm.js')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/remend/dist/index.js')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/mermaid/dist/mermaid.core.mjs')).toBeUndefined();
  });
  it('keeps lazy editor and highlighting dependencies on their natural import graph', () => {
    expect(frontendManualChunk('/repo/node_modules/@tiptap/react/dist/index.js')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/shiki/dist/core.mjs')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/@shikijs/core/dist/index.mjs')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/react/jsx-runtime.js')).toBe('react-vendor');
  });

  it('keeps rehype-katex on the dynamic import graph', () => {
    expect(frontendManualChunk('/repo/node_modules/rehype-katex/lib/index.js')).toBeUndefined();
  });

  it('lets Rollup preserve the natural dynamic boundary for the whole markdown family', () => {
    expect(frontendManualChunk('/repo/node_modules/katex/dist/katex.mjs')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/rehype-raw/lib/index.js')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/react-markdown/lib/index.js')).toBeUndefined();
  });

  it('puts React core in react-vendor so it cannot merge into the lazy editor chunk', () => {
    expect(frontendManualChunk('/repo/node_modules/react/index.js')).toBe('react-vendor');
    expect(frontendManualChunk('/repo/node_modules/react/jsx-runtime.js')).toBe('react-vendor');
    expect(frontendManualChunk('/repo/node_modules/react/cjs/react.production.js')).toBe('react-vendor');
    expect(frontendManualChunk('/repo/node_modules/react-dom/client.js')).toBe('react-vendor');
    expect(frontendManualChunk('/repo/node_modules/scheduler/index.js')).toBe('react-vendor');
    expect(frontendManualChunk('/repo/node_modules/use-sync-external-store/shim/index.js')).toBe('react-vendor');
  });

  it('keeps React-named editor and markdown packages out of react-vendor', () => {
    expect(frontendManualChunk('/repo/node_modules/@tiptap/react/dist/index.js')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/react-markdown/lib/index.js')).not.toBe('react-vendor');
    expect(frontendManualChunk('/repo/node_modules/react-dom-extra/index.js')).not.toBe('react-vendor');
  });
});
