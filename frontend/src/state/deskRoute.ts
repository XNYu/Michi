import { useSyncExternalStore } from 'react';

export interface DeskProjectTarget {
  id: string;
  title: string;
}

let project: DeskProjectTarget | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function openDeskProject(next: DeskProjectTarget): void {
  if (project?.id === next.id && project.title === next.title) return;
  project = next;
  emit();
}

export function useDeskProject(): DeskProjectTarget | null {
  return useSyncExternalStore(subscribe, () => project, () => project);
}

/** Test-only reset. */
export function _resetDeskRouteForTest(): void {
  project = null;
  listeners.clear();
}
