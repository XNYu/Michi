import { describe, it, expect } from 'vitest';
import { shouldRetryBackendSync } from './workspacePersistence';
import type { SyncWorkspaceResponse } from '../services/api';

describe('shouldRetryBackendSync', () => {
  it('does NOT retry a normal accepted response', () => {
    const resp: SyncWorkspaceResponse = { ok: true, newRev: 7 };
    expect(shouldRetryBackendSync(resp, false)).toBe(false);
  });

  it('does NOT retry a tombstoned/ignored but ok response', () => {
    const resp: SyncWorkspaceResponse = { ok: true, ignored: 'tombstoned' };
    expect(shouldRetryBackendSync(resp, false)).toBe(false);
  });

  it('retries when the promise rejected (network / SQLITE_BUSY past timeout / 500)', () => {
    // On a throw the caller has no response body; failed=true forces a retry.
    expect(shouldRetryBackendSync(null, true)).toBe(true);
    expect(shouldRetryBackendSync(undefined, true)).toBe(true);
  });

  it('retries on an explicit ok:false response body', () => {
    const resp = { ok: false } as SyncWorkspaceResponse;
    expect(shouldRetryBackendSync(resp, false)).toBe(true);
  });

  it('retries when resolved with no response body', () => {
    expect(shouldRetryBackendSync(null, false)).toBe(true);
    expect(shouldRetryBackendSync(undefined, false)).toBe(true);
  });
});
