export type FrontendChunkName =
  | 'react-vendor'
  | 'markdown-code'
  | 'markdown-streamdown';

/**
 * Keep the production chunk policy independently testable. In particular,
 * rehype-katex must remain on the dynamic import graph; grouping it with the
 * statically imported rehype packages makes KaTeX block every cold start.
 */
export function frontendManualChunk(id: string): FrontendChunkName | undefined {
  if (id.includes('node_modules/react-dom')) return 'react-vendor';
  // Do not manually group the markdown/unified family. Rehype-katex and its
  // engine are dynamically imported, while the rest is static today; broad
  // manual chunks merge those two graphs and promote KaTeX to the boot path.
  if (
    id.includes('node_modules/rehype-katex') ||
    id.includes('node_modules/katex')
  )
    return undefined;

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

  return undefined;
}
