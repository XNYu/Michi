import { useSyncExternalStore } from 'react';
import { redactRemoteLog, type RemoteConnectionDiagnostic } from 'michi-shared';
import type { BackendConnectionSummary } from '../config/backendConnections';
import { RemoteServiceRecoveryError } from '../services/api/remoteRecovery';

export interface RemoteRecoveryIssue {
  connectionId: string;
  name: string;
  attempts: number;
  retrying: boolean;
  dismissed: boolean;
  diagnostic: RemoteConnectionDiagnostic;
  serviceDiagnosticId?: string;
  history?: string;
}

export const REMOTE_WORKSPACE_RETRY_EVENT = 'michi:retry-remote-workspace';
let issues: readonly RemoteRecoveryIssue[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const getRemoteRecoveryIssues = () => issues;

/** Hide the notice for these incidents without interrupting recovery or losing diagnostics. */
export function dismissRemoteRecoveryIssues(): void {
  if (issues.every(issue => issue.dismissed)) return;
  issues = issues.map(issue => ({ ...issue, dismissed: true }));
  emit();
}

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

export function reportRemoteRecoveryFailure(connection: BackendConnectionSummary, error: unknown, serviceReport?: RemoteConnectionDiagnostic): void {
  if (error instanceof RemoteServiceRecoveryError) {
    const status = error.recovery;
    if (status.phase === 'starting') { reportRemoteRecoveryProgress(connection, status.message, status.diagnostic); return; }
    serviceReport = status.diagnostic;
    error = new Error(status.message);
  }
  const previous = issues.find(issue => issue.connectionId === connection.id);
  const sameServiceAttempt = !!serviceReport && previous?.serviceDiagnosticId === serviceReport.id;
  const message = redactRemoteLog(error instanceof Error ? error.message : String(error));
  const attempts = (previous?.attempts ?? 0) + (sameServiceAttempt && previous.diagnostic.severity === 'error' ? 0 : 1);
  const startedAt = serviceReport?.startedAt ?? previous?.diagnostic.startedAt ?? new Date().toISOString();
  const entry = `${new Date().toISOString()} [workspace recovery attempt ${attempts}] ${message}\n`;
  const history = sameServiceAttempt ? previous.history : previous?.diagnostic.log;
  const log = (history ?? 'Client-side workspace recovery log.\n') + entry
    + (serviceReport ? redactRemoteLog(serviceReport.log) : 'No remote service logs were collected for this request.\n');
  const issue: RemoteRecoveryIssue = {
    connectionId: connection.id, name: redactRemoteLog(connection.name), attempts, retrying: false,
    dismissed: previous?.dismissed ?? false,
    serviceDiagnosticId: serviceReport?.id, history: history?.slice(-32_000),
    diagnostic: {
      id: serviceReport?.id ?? previous?.diagnostic.id ?? 'recovery-' + crypto.randomUUID(),
      host: redactRemoteLog(connection.sshHost ?? connection.apiUrl ?? connection.name),
      startedAt, stage: 'workspace', code: 'remote_workspace_unavailable', message,
      severity: 'error',
      ...(serviceReport ? { stage: serviceReport.stage, code: serviceReport.code ?? 'remote_workspace_unavailable', severity: serviceReport.severity ?? 'error', localLogPath: serviceReport.localLogPath, authentication: serviceReport.authentication } : {}),
      log: log.slice(-32_000), truncated: (previous?.diagnostic.truncated ?? false) || (serviceReport?.truncated ?? false) || log.length > 32_000,
    },
  };
  issues = previous ? issues.map(item => item.connectionId === connection.id ? issue : item) : [...issues, issue];
  emit();
}

/** Replace this attempt's live snapshot without counting each poll as a failure. */
export function reportRemoteRecoveryProgress(connection: BackendConnectionSummary, message: string, serviceReport?: RemoteConnectionDiagnostic): void {
  const previous = issues.find(issue => issue.connectionId === connection.id);
  const sameAttempt = !!serviceReport && previous?.serviceDiagnosticId === serviceReport.id;
  if (sameAttempt && previous.diagnostic.severity === 'error') return; // Ignore a late pre-failure HTTP response.
  const history = (sameAttempt ? previous.history : previous?.diagnostic.log ?? 'Client-side workspace recovery log.\n') ?? '';
  const log = history + (serviceReport ? redactRemoteLog(serviceReport.log) : 'Waiting for remote startup diagnostics.\n');
  const issue: RemoteRecoveryIssue = {
    connectionId: connection.id, name: redactRemoteLog(connection.name), attempts: previous?.attempts ?? 0,
    retrying: true, dismissed: previous?.dismissed ?? false, serviceDiagnosticId: serviceReport?.id,
    history: history.slice(-32_000),
    diagnostic: {
      ...(serviceReport ?? {}),
      id: serviceReport?.id ?? previous?.diagnostic.id ?? 'recovery-' + crypto.randomUUID(),
      host: redactRemoteLog(connection.sshHost ?? connection.apiUrl ?? connection.name),
      startedAt: serviceReport?.startedAt ?? previous?.diagnostic.startedAt ?? new Date().toISOString(),
      stage: serviceReport?.stage ?? 'ssh', severity: 'info', code: undefined, message: redactRemoteLog(message),
      log: log.slice(-32_000), truncated: !!(previous?.diagnostic.truncated || serviceReport?.truncated || log.length > 32_000),
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
