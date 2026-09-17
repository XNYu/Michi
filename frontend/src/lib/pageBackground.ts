import type { PageId } from '../state/commands';

/**
 * CSS background value for each page's body area.
 *
 * The Topbar and the shell container both use this mapping so the topbar
 * background always matches the page it sits above — no per-page maintenance
 * in the Topbar itself. When adding a new page, add its entry here and the
 * Topbar will pick it up automatically.
 */
export function pageBackground(page: PageId): string {
  switch (page) {
    // Canvas pages — cards float on the slightly warm bg layer.
    case 'home':
    case 'workspaces':
    case 'archived':
      return 'var(--term-bg)';

    case 'trash':
      return 'color-mix(in srgb, var(--term-surface) 72%, var(--term-bg))';

    // Document / editor pages — use the semantic page-bg token.
    case 'digest':
    case 'workspace-manage':
    case 'agents':
    case 'agent-manage':
    case 'profile':
      return 'var(--term-page-bg, var(--term-bg))';

    // Graph/branch pages — a 60/40 mix of bg + surface.
    case 'map':
    case 'branches':
      return 'color-mix(in srgb, var(--term-bg) 60%, var(--term-surface))';

    // Dashboard — pane surfaces match the topbar surface.
    case 'dashboard':
    case 'settings':
    default:
      return 'var(--term-pane-bg, var(--term-surface))';
  }
}
