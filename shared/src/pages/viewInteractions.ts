import type { PageBlock, PageBlockInput } from './blocks';

export const PAGE_VIEW_PRESENTATIONS = ['inline', 'drawer', 'modal'] as const;
export type PageViewPresentation = typeof PAGE_VIEW_PRESENTATIONS[number];
export interface PageViewAction { type: 'open-view'; viewId: string; presentation?: PageViewPresentation }
export interface PageViewInteraction { label: string; action: PageViewAction }
export interface PageViewBlock { type: 'view'; viewId: string; title: string; blockIds: string[] }
export interface PageViewLinkBlock { type: 'view-link'; label: string; action: PageViewAction }

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isPageViewId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(v);
export function parsePageViewAction(value: unknown): PageViewAction | null {
  if (!record(value) || Object.keys(value).some(k => !['type', 'viewId', 'presentation'].includes(k)) || value.type !== 'open-view' || !isPageViewId(value.viewId) ||
    (value.presentation !== undefined && !PAGE_VIEW_PRESENTATIONS.includes(value.presentation as PageViewPresentation))) return null;
  return { type: 'open-view', viewId: value.viewId, ...(value.presentation ? { presentation: value.presentation as PageViewPresentation } : {}) };
}
export function parsePageViewInteraction(value: unknown): PageViewInteraction | null {
  if (!record(value) || Object.keys(value).some(k => !['label', 'action'].includes(k)) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200) return null;
  const action = parsePageViewAction(value.action);
  return action ? { label: value.label, action } : null;
}

/** Local Markdown links never navigate the app or claim an external URL. */
export function pageViewActionFromHref(href: string): PageViewAction | null {
  const match = /^#view\/([a-zA-Z][a-zA-Z0-9_-]{0,79})(?:\?(?:presentation)=(inline|drawer|modal))?$/.exec(href);
  return match ? { type: 'open-view', viewId: match[1], ...(match[2] ? { presentation: match[2] as PageViewPresentation } : {}) } : null;
}

export function pageViewIndex(blocks: readonly PageBlock[]) {
  const views = new Map<string, PageViewBlock>();
  for (const block of blocks) if (block.type === 'view') views.set(block.viewId, block);
  return views;
}

function children(block: PageBlockInput): PageBlockInput[] {
  if (block.type === 'toggle') return block.blocks;
  if (block.type === 'columns') return block.columns.flat();
  if (block.type === 'tabs') return block.tabs.flatMap(tab => tab.blocks);
  if (block.type === 'grid') return block.regions.flatMap(region => region.blocks);
  return [];
}

/** References remain page-local and reuse the original top-level block's ownership/history. */
export function pageViewProblem(blocks: readonly PageBlock[]): string | null {
  const byId = new Map(blocks.map(block => [block.id, block]));
  const views = pageViewIndex(blocks);
  if (views.size !== blocks.filter(block => block.type === 'view').length) return 'View names must be unique within a page';
  for (const view of views.values()) for (const id of view.blockIds) {
    const target = byId.get(id);
    if (!target) return `View ${view.viewId} refers to missing block ${id}`;
    if (target.type === 'view') return 'A view references content blocks, not another view definition';
  }
  const visit = (block: PageBlockInput): string | null => {
    const actions = [block.interaction?.action, ...(block.type === 'view-link' ? [block.action] : []),
      ...(block.type === 'metrics' ? block.items.map(item => item.action) : [])];
    for (const action of actions) if (action && !views.has(action.viewId)) return `View ${action.viewId} does not exist in this page`;
    for (const child of children(block)) { const problem = visit(child); if (problem) return problem; }
    return null;
  };
  for (const block of blocks) { const problem = visit(block); if (problem) return problem; }
  return null;
}
