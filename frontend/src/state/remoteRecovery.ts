import { useSyncExternalStore } from 'react';
import { redactRemoteLog, type RemoteConnectionDiagnostic } from 'michi-shared';
import type { BackendConnectionSummary } from '../config/backendConnections';

export interface RemoteRecoveryIssue {
  connectionId: string;
  name: string;
  attempts: number;
  retrying: boolean;
  diagnostic: RemoteConnectionDiagnostic;
}

export const REMOTE_WORKSPACE_RETRY_EVENT = 'michi:retry-remote-workspace';
let issues: readonly RemoteRecoveryIssue[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const getRemoteRecoveryIssues = () => issues;

export function clearRemoteRecoveryIssue(connectionId: string): void {
  const next = issues.filter(issue => issue.connectionId !== connectionId);
  if (next.length === issues.length) return;
  issues = next; emit();
}

export function markRemoteRecoveryRetrying(connectionId: string): void {
  if (!issues.some(issue => issue.connectionId === connectionId && !issue.retrying)) return;
  issues = issues.map(issue => issue.connectionId === connectionId ? { ...issue, retrying: true } : issue);
  emit();
}

export function reportRemoteRecoveryFailure(connection: BackendConnectionSummary, error: unknown): void {
  const previous = issues.find(issue => issue.connectionId === connection.id);
  const message = redactRemoteLog(error instanceof Error ? error.message : String(error));
  const attempts = (previous?.attempts ?? 0) + 1;
  const startedAt = previous?.diagnostic.startedAt ?? new Date().toISOString();
  const entry = `${new Date().toISOString()} [workspace recovery attempt ${attempts}] ${message}\n`;
  const log = (previous?.diagnostic.log ?? 'Client-side workspace recovery log. No remote service logs were collected.\n') + entry;
  const issue: RemoteRecoveryIssue = {
    connectionId: connection.id, name: redactRemoteLog(connection.name), attempts, retrying: false,
    diagnostic: {
      id: previous?.diagnostic.id ?? 'recovery-' + crypto.randomUUID(),
      host: redactRemoteLog(connection.sshHost ?? connection.apiUrl ?? connection.name),
      startedAt, stage: 'workspace', code: 'remote_workspace_unavailable', message,
      log: log.slice(-32_000), truncated: (previous?.diagnostic.truncated ?? false) || log.length > 32_000,
    },
  };
  issues = previous ? issues.map(item => item.connectionId === connection.id ? issue : item) : [...issues, issue];
  emit();
}

export function retryRemoteWorkspace(connectionId: string): void {
  window.dispatchEvent(new CustomEvent(REMOTE_WORKSPACE_RETRY_EVENT, { detail: { connectionId } }));
}

export function useRemoteRecoveryIssues(): readonly RemoteRecoveryIssue[] {
  return useSyncExternalStore(callback => {
    listeners.add(callback);
    return () => { listeners.delete(callback); };
  }, getRemoteRecoveryIssues, getRemoteRecoveryIssues);
}
