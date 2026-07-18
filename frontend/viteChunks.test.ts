import { describe, expect, it } from 'vitest';
import { frontendManualChunk } from './viteChunks';

describe('frontendManualChunk', () => {
  it('keeps rehype-katex on the dynamic import graph', () => {
    expect(frontendManualChunk('/repo/node_modules/rehype-katex/lib/index.js')).toBeUndefined();
  });

  it('lets Rollup preserve the natural dynamic boundary for the whole markdown family', () => {
    expect(frontendManualChunk('/repo/node_modules/katex/dist/katex.mjs')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/rehype-raw/lib/index.js')).toBeUndefined();
    expect(frontendManualChunk('/repo/node_modules/react-markdown/lib/index.js')).toBeUndefined();
  });
});
