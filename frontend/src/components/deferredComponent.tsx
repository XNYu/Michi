import { useEffect, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';

/** On-demand module loading with an immediate ready-state update. Unlike a
 * Suspense fallback, this placeholder does not impose a reveal delay after the
 * import completes. Define once at module scope; instances share the import.
 * Component-internal suspension and errors still belong to the parent's boundary.
 */
export function deferredComponent<P extends object>(
  importer: () => Promise<{ default: ComponentType<P> }>,
  fallback: ReactNode,
): ComponentType<P> {
  type Snapshot = { kind: 'pending' } | { kind: 'ready'; Component: ComponentType<P> } | { kind: 'failed'; error: unknown };
  let snapshot: Snapshot = { kind: 'pending' };
  let request: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const read = () => snapshot;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const publish = (next: Snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const load = () => {
    request ??= Promise.resolve().then(importer).then(
      module => publish({ kind: 'ready', Component: module.default }),
      error => publish({ kind: 'failed', error }),
    );
  };
  return function DeferredComponent(props: P) {
    const current = useSyncExternalStore(subscribe, read, read);
    useEffect(load, []);
    if (current.kind === 'failed') throw current.error;
    if (current.kind === 'pending') return <>{fallback}</>;
    return <current.Component {...props} />;
  };
}
