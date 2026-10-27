export interface PageEventIdentity {
  backendConnectionId: string;
  workspaceId?: string;
  pageId?: string;
  databaseId?: string;
  componentId?: string;
  /** A committed page receipt's minimum observable version, not a database revision. */
  viewVersion?: number;
}

type PageListener = (identity: PageEventIdentity) => void;
const listeners = new Set<PageListener>();

export function notifyPageChanged(identity: PageEventIdentity): void {
  for (const listener of listeners) listener(identity);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<PageEventIdentity>('michi:page-changed', { detail: identity }));
  }
}

export function subscribePageChanges(identity: PageEventIdentity, listener: PageListener): () => void {
  const scoped: PageListener = (changed) => {
    if (changed.backendConnectionId !== identity.backendConnectionId || (identity.workspaceId && changed.workspaceId !== identity.workspaceId)) return;
    if (identity.pageId && changed.pageId && changed.pageId !== identity.pageId && !changed.databaseId) return;
    if (identity.databaseId && changed.databaseId && changed.databaseId !== identity.databaseId) return;
    if (identity.componentId && changed.componentId && changed.componentId !== identity.componentId) return;
    // A database mutation can alter the rendered contents of any page that
    // references it. Page subscribers therefore accept database-only events
    // within their workspace; database subscribers still filter by database ID.
    if (identity.databaseId && changed.pageId && !changed.databaseId) return;
    listener(changed);
  };
  listeners.add(scoped);
  return () => listeners.delete(scoped);
}
