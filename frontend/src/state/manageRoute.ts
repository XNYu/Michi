import { useSyncExternalStore } from 'react';

let manageWorkspaceId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setManageWorkspaceId(id: string | null): void {
  if (manageWorkspaceId === id) return;
  manageWorkspaceId = id;
  emit();
}

export function getManageWorkspaceId(): string | null {
  return manageWorkspaceId;
}

export function useManageWorkspaceId(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => manageWorkspaceId,
    () => manageWorkspaceId,
  );
}

/** Test-only reset; do not call from app code. */
export function _resetForTest(): void {
  manageWorkspaceId = null;
  listeners.clear();
}
