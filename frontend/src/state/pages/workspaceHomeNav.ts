import { useSyncExternalStore } from 'react';

/**
 * Opening one workspace's home in Spaces from anywhere (a Home row, a
 * workspace mention, a link in the chat window). The terminal shell answers
 * the event, so the area, the view and the crumb all follow; with no shell
 * mounted (a Spaces page rendered on its own) the request is held here and
 * the Spaces page shows it.
 */
export const OPEN_WORKSPACE_HOME_EVENT = 'michi:open-workspace-home';

export interface WorkspaceHomeTarget {
  workspaceId: string;
  backendConnectionId: string;
}

let held: WorkspaceHomeTarget | null = null;
const listeners = new Set<() => void>();

function setHeld(next: WorkspaceHomeTarget | null): void {
  if (held === next) return;
  held = next;
  for (const listener of listeners) listener();
}

export function requestWorkspaceHome(target: WorkspaceHomeTarget): void {
  const answered = !window.dispatchEvent(new CustomEvent<WorkspaceHomeTarget>(OPEN_WORKSPACE_HOME_EVENT, { detail: target, cancelable: true }));
  setHeld(answered ? null : target);
}

export function isWorkspaceHomeTarget(value: unknown): value is WorkspaceHomeTarget {
  const target = value as Partial<WorkspaceHomeTarget> | null;
  return !!target && typeof target.workspaceId === 'string' && !!target.workspaceId && typeof target.backendConnectionId === 'string';
}

export function readHeldWorkspaceHome(): WorkspaceHomeTarget | null {
  return held;
}

export function clearHeldWorkspaceHome(): void {
  setHeld(null);
}

export function useHeldWorkspaceHome(): WorkspaceHomeTarget | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    readHeldWorkspaceHome,
    readHeldWorkspaceHome,
  );
}
