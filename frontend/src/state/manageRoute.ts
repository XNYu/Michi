import { useSyncExternalStore } from 'react';

let manageWorkspaceId: string | null = null;
export interface ManageAgentRoute {
  mode: 'create' | 'edit';
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  backendConnectionId: string;
  definitionId: string | null;
}

let manageAgentRoute: ManageAgentRoute | null = null;
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

export function setManageAgentRoute(route: ManageAgentRoute | null): void {
  const next = route ? JSON.stringify(route) : null;
  const current = manageAgentRoute ? JSON.stringify(manageAgentRoute) : null;
  if (next === current) return;
  manageAgentRoute = route;
  emit();
}

export function getManageAgentRoute(): ManageAgentRoute | null {
  return manageAgentRoute;
}

export function useManageAgentRoute(): ManageAgentRoute | null {
  return useSyncExternalStore(subscribe, () => manageAgentRoute, () => manageAgentRoute);
}

/** Test-only reset; do not call from app code. */
export function _resetForTest(): void {
  manageWorkspaceId = null;
  manageAgentRoute = null;
  listeners.clear();
}
