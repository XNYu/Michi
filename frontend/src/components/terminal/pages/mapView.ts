// Shared definition of the Map page's three top-level views. Lives in its own
// module so the Topbar (which hosts the segmented switcher) and the Map page
// body can both import it without a circular dependency.

export type MapView = 'graph' | 'timeline' | 'doc';

export const MAP_VIEWS: readonly MapView[] = ['graph', 'timeline', 'doc'];

export const MAP_VIEW_LABELS: Record<MapView, string> = {
  graph: 'Graph',
  timeline: 'Timeline',
  doc: 'Doc',
};
