import type { RemoteConnectionDiagnostic } from './remoteDiagnostics';

export interface MichiBuildInfo {
  version: string;
  revision: string | null;
  dirty?: boolean;
}

export interface RemoteUpdateStatus {
  local: MichiBuildInfo;
  remote: MichiBuildInfo | null;
  state: 'current' | 'older' | 'different' | 'unknown';
  canUpdate: boolean;
  message?: string;
}

/**
 * The gateway's latest update attempt for one saved machine. An accepted
 * update outlives the view that started it, so any view can follow it.
 */
export interface RemoteUpdateJob {
  connectionId: string;
  attemptId: string;
  phase: 'running' | 'succeeded' | 'failed';
  stage: string;
  message: string;
  startedAt: string;
  finishedAt?: string;
  /** Verified remote version after success. */
  result?: RemoteUpdateStatus;
  /** Saved failure report; omitted while running. */
  diagnostic?: RemoteConnectionDiagnostic;
}
