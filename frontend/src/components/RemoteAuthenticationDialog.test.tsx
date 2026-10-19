import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteAuthenticationDialog } from './RemoteAuthenticationDialog';
import { closeRemoteAuthentication, completeRemoteAuthentication, requestRemoteAuthentication } from '../state/remoteAuthentication';

const state = vi.hoisted(() => ({
  bridge: null as Record<string, unknown> | null,
  recover: vi.fn().mockResolvedValue(undefined),
  input: null as ((data: string) => void) | null,
  data: null as ((id: string, data: string) => void) | null,
  exit: null as ((id: string, code: number) => void) | null,
}));
vi.mock('../lib/electronBridge', () => ({ getElectron: () => state.bridge }));
vi.mock('../../../shared/src/remoteCredentials', () => ({ REMOTE_CREDENTIALS: {
  name: 'Example SSO', localAction: 'Refresh Example SSO on this computer', localCommand: ['example-login'],
  remoteCommand: ['example-login', '--remote'], remoteCookie: null,
  remoteCredentialError: /example-login|example sso.*expired/i, localCredentialError: null,
} }));
vi.mock('../services/api/remoteRecovery', () => ({ recoverRemoteService: state.recover }));
vi.mock('../state/prefs', () => ({ usePrefs: () => ({ prefs: { terminalPalette: 'bone', terminalAccentOverrides: {} } }) }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  options = {}; cols = 80; rows = 20;
  loadAddon() {} open() {} write() {} focus() {} dispose() {}
  onData(callback: (data: string) => void) { state.input = callback; return { dispose: vi.fn() }; }
} }));
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  state.bridge = {
    remoteAuthCreate: vi.fn().mockResolvedValue({ data: '', exited: false }),
    terminalWrite: vi.fn(), terminalResize: vi.fn(), terminalDestroy: vi.fn(),
    onTerminalData: (callback: typeof state.data) => { state.data = callback; return vi.fn(); },
    onTerminalExit: (callback: typeof state.exit) => { state.exit = callback; return vi.fn(); },
  };
});
afterEach(() => { closeRemoteAuthentication(); for (const key of ['native-success', 'native-fail', 'web-fallback', 'web-cancel', 'strict-auth']) completeRemoteAuthentication(key); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('starts authentication only once under StrictMode effect replay', async () => {
  requestRemoteAuthentication({ key: 'strict-auth', target: { scope: 'local', host: 'test-host' } }, true);
  render(<StrictMode><RemoteAuthenticationDialog /></StrictMode>);
  await waitFor(() => expect(state.bridge!.remoteAuthCreate).toHaveBeenCalledOnce());
});

it('opens a dedicated remote PTY, forwards user input, reconnects once after success and destroys on close', async () => {
  const onComplete = vi.fn();
  requestRemoteAuthentication({ key: 'native-success', target: { scope: 'remote', host: 'test-host' }, connectionId: 'remote', onComplete }, true);
  const view = render(<RemoteAuthenticationDialog />);
  const create = vi.mocked(state.bridge!.remoteAuthCreate as (...args: unknown[]) => Promise<unknown>);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  const id = create.mock.calls[0][0] as string;
  expect(create.mock.calls[0][1]).toEqual({ scope: 'remote', host: 'test-host' });
  act(() => { state.input?.('user-input'); });
  expect(state.bridge!.terminalWrite).toHaveBeenCalledWith(id, 'user-input');
  await act(async () => { state.exit?.(id, 0); state.exit?.(id, 0); });
  expect(state.recover).toHaveBeenCalledOnce(); expect(onComplete).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
  view.unmount(); expect(state.bridge!.terminalDestroy).toHaveBeenCalledWith(id);
});

it('does not reconnect after a failed sign-in and supports retry and cancel', async () => {
  requestRemoteAuthentication({ key: 'native-fail', target: { scope: 'local', host: 'test-host' }, connectionId: 'remote' }, true);
  render(<RemoteAuthenticationDialog />);
  const create = vi.mocked(state.bridge!.remoteAuthCreate as (...args: unknown[]) => Promise<unknown>);
  await waitFor(() => expect(create).toHaveBeenCalledOnce());
  act(() => state.exit?.(create.mock.calls[0][0] as string, 1));
  expect(state.recover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Try sign-in again' }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(state.bridge!.terminalDestroy).toHaveBeenCalledWith(create.mock.calls[1][0]);
});

it('keeps a selectable command and clipboard fallback in the browser', async () => {
  state.bridge = null;
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  requestRemoteAuthentication({ key: 'web-fallback', target: { scope: 'remote', host: 'test-host', user: 'u', port: 2222 } }, true);
  render(<RemoteAuthenticationDialog />);
  fireEvent.click(await screen.findByRole('button', { name: 'Copy command' }));
  await screen.findByRole('button', { name: 'Copied' });
  expect(copy).toHaveBeenCalledWith("ssh -tt -p 2222 u@test-host 'example-login --remote'");
});

it('does not run the reconnect callback when the browser dialog closes during recovery', async () => {
  state.bridge = null;
  let resolve!: () => void;
  state.recover.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const onComplete = vi.fn();
  requestRemoteAuthentication({ key: 'web-cancel', connectionId: 'remote', target: { scope: 'remote', host: 'test-host' }, onComplete }, true);
  render(<RemoteAuthenticationDialog />);
  fireEvent.click(await screen.findByRole('button', { name: 'I signed in — reconnect' }));
  act(() => closeRemoteAuthentication());
  await act(async () => { resolve(); });
  expect(onComplete).not.toHaveBeenCalled();
});
