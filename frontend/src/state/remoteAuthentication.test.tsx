import { afterEach, expect, it, vi } from 'vitest';
import { closeRemoteAuthentication, completeRemoteAuthentication, getRemoteAuthentication, reportRemoteCredentialError, reportRemoteRuntimeReady, requestRemoteAuthentication } from './remoteAuthentication';
import { indexBackendProjects, setKnownBackendConnections } from '../config/backendConnections';
vi.mock('../../../shared/src/remoteCredentials', () => ({ REMOTE_CREDENTIALS: {
  name: 'Example SSO', localAction: 'Refresh Example SSO on this computer', localCommand: ['example-login'],
  remoteCommand: ['example-login', '--remote'], remoteCookie: null,
  remoteCredentialError: /example-login|example sso.*expired/i, localCredentialError: null,
} }));
afterEach(() => { closeRemoteAuthentication(); for (const key of ['runtime:remote', 'incident', 'other']) completeRemoteAuthentication(key); setKnownBackendConnections([]); indexBackendProjects([]); });

it('only prompts for remote credential errors on an SSH-backed node and keeps unrelated errors quiet', () => {
  setKnownBackendConnections([{ id: 'remote', name: 'Remote', transport: 'ssh', sshHost: 'box', hasToken: true, createdAt: 1, updatedAt: 1 }]);
  indexBackendProjects([{ id: 'workspace', backendConnectionId: 'remote', chatIds: ['remote-node'] }]);
  reportRemoteCredentialError('remote-node', 'Codex request timed out');
  reportRemoteCredentialError('local-node', 'Run example-login --remote');
  expect(getRemoteAuthentication()).toBeNull();
  reportRemoteCredentialError('remote-node', 'Example SSO session expired');
  expect(getRemoteAuthentication()?.target).toMatchObject({ scope: 'remote', host: 'box' });
});
it('does not interrupt active sign-in and deduplicates automatic prompts while permitting manual reopening', () => {
  const request = { key: 'incident', target: { scope: 'local' as const, host: 'box' } };
  requestRemoteAuthentication(request);
  requestRemoteAuthentication({ ...request, key: 'other' });
  expect(getRemoteAuthentication()?.key).toBe('incident');
  closeRemoteAuthentication(); requestRemoteAuthentication(request);
  expect(getRemoteAuthentication()).toBeNull();
  requestRemoteAuthentication(request, true); expect(getRemoteAuthentication()?.key).toBe('incident');
});
it('allows a later expiry to prompt again after an externally authenticated turn succeeds', () => {
  setKnownBackendConnections([{ id: 'remote', name: 'Remote', transport: 'ssh', sshHost: 'box', hasToken: true, createdAt: 1, updatedAt: 1 }]);
  indexBackendProjects([{ id: 'workspace', backendConnectionId: 'remote', chatIds: ['remote-node'] }]);
  reportRemoteCredentialError('remote-node', 'Run example-login --remote');
  closeRemoteAuthentication();
  reportRemoteCredentialError('remote-node', 'Run example-login --remote');
  expect(getRemoteAuthentication()).toBeNull();
  reportRemoteRuntimeReady('local-node');
  reportRemoteCredentialError('remote-node', 'Run example-login --remote');
  expect(getRemoteAuthentication()).toBeNull();
  reportRemoteRuntimeReady('remote-node');
  reportRemoteCredentialError('remote-node', 'Run example-login --remote');
  expect(getRemoteAuthentication()?.key).toBe('runtime:remote');
});
