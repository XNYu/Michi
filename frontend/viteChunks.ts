export type FrontendChunkName = 'react-vendor';

/**
 * Keep React and its scheduler together; let Rollup follow actual dynamic
 * imports for editors, highlighting, diagrams and math. Broad manual vendor
 * groups can promote a lazy engine to the boot path when they absorb a shared
 * helper or bundle it with a synchronous consumer (for example marked).
 */
export function frontendManualChunk(id: string): FrontendChunkName | undefined {
  if (/\/node_modules\/(?:react|react-dom|scheduler|use-sync-external-store)\//.test(id)) return 'react-vendor';
  return undefined;
}
