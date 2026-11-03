import type { MichiBuildInfo } from './remoteUpdate';

/**
 * A backend updating its own installation to the latest source branch
 * (`michi update`), started from the phone's Settings → Update. Only a Linux
 * remote backend (one with remote.env) can do this; see
 * backend/src/services/selfUpdate.ts.
 */
export interface SelfUpdateCommit {
  revision: string;
  subject: string;
  /** Committer date, ISO 8601. */
  date: string;
}

export interface SelfUpdateJob {
  id: string;
  phase: 'running' | 'succeeded' | 'failed';
  /** The step `michi update` last reported. */
  stage: 'building' | 'switching' | 'done';
  /** Its latest progress line, or why it failed. */
  message: string;
  /** Revision the backend ran when the update started. */
  from: string | null;
  /** Latest revision the update was confirmed for. */
  target: string;
  startedAt: string;
  finishedAt?: string;
  /** This attempt's output, on the machine being updated. */
  logFile: string;
}

export interface SelfUpdateStatus {
  /** False when this backend cannot update itself; `reason` says why. */
  supported: boolean;
  reason?: string;
  /** Source branch updates follow ("main"). */
  branch: string;
  current: MichiBuildInfo;
  job: SelfUpdateJob | null;
}

export interface SelfUpdateCheck extends SelfUpdateStatus {
  /** `available`: the branch has commits this build lacks. */
  state: 'current' | 'available';
  latest: string;
  /** Newest first, at most SELF_UPDATE_COMMIT_LIMIT. */
  commits: SelfUpdateCommit[];
  /** All commits the update brings in. */
  total: number;
  /** Set when an update is available but cannot start here. */
  blocked?: string;
  checkedAt: string;
}

export const SELF_UPDATE_COMMIT_LIMIT = 20;
