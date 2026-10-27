import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePermissionPreferences } from './usePermissionPreferences';

const save = vi.hoisted(() => vi.fn(async (settings) => settings));
vi.mock('../state/prefs', () => ({ usePrefs: () => ({ prefs: { globalPermissions: true, permissionMode: 'yolo' }, setPermissionSettings: vi.fn() }) }));
vi.mock('../services/api/prefs', () => ({ savePermissionSettings: save }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
function Probe({ base }: { base: string }) {
  const permissions = usePermissionPreferences(base);
  return <div><output>{base}:{String(permissions.global)}:{permissions.mode}</output>
    <span>{permissions.loading ? `Loading ${base}` : `Ready ${base}`}</span>
    {permissions.error && <span role="alert">{permissions.error}</span>}
    <button onClick={() => { void permissions.retry(); }}>Retry {base}</button>
    <button onClick={() => { void permissions.save({ global: true, mode: 'trust' }); }}>Trust {base}</button></div>;
}
it('remote controls read and update their own gateway without inheriting local YOLO', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ global: false, mode: 'ask' }) })));
  render(<><Probe base="/gateway/a" /><Probe base="/gateway/a" /><Probe base="/gateway/b" /></>);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getAllByText('Trust /gateway/a')[0]);
  await waitFor(() => expect(screen.getAllByText('/gateway/a:true:trust')).toHaveLength(2));
  expect(save).toHaveBeenCalledWith({ global: true, mode: 'trust' }, '/gateway/a');
  expect(screen.getByText('/gateway/b:false:ask')).toBeTruthy();
});

it('a refresh started during a save cannot overwrite the acknowledged remote mode', async () => {
  let resolveSave!: (settings: unknown) => void;
  let resolveRefresh!: (response: unknown) => void;
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ global: false, mode: 'ask' }) })
    .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  vi.stubGlobal('fetch', fetchMock);
  save.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  render(<Probe base="/gateway/save-race" />);
  await waitFor(() => expect(screen.getByText('/gateway/save-race:false:ask')).toBeTruthy());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText('Trust /gateway/save-race'));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await act(async () => { resolveSave({ global: true, mode: 'trust' }); });
  expect(screen.getByText('/gateway/save-race:true:trust')).toBeTruthy();
  await act(async () => { resolveRefresh({ ok: true, json: async () => ({ global: false, mode: 'ask' }) }); });
  expect(screen.getByText('/gateway/save-race:true:trust')).toBeTruthy();
});

it('finishes initial loading on failure and exposes an explicit retry', async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce(new Response(JSON.stringify({ global: true, mode: 'trust' })));
  vi.stubGlobal('fetch', fetchMock);
  render(<Probe base="/gateway/retry" />);
  await waitFor(() => expect(screen.getByText('Ready /gateway/retry')).toBeTruthy());
  expect(screen.getByRole('alert').textContent).toContain('temporary failure');
  fireEvent.click(screen.getByText('Retry /gateway/retry'));
  await waitFor(() => expect(screen.getByText('/gateway/retry:true:trust')).toBeTruthy());
  expect(screen.queryByRole('alert')).toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('discards the old connection generation on reconnect while the same controls remain mounted', async () => {
  const { markBackendConnectionUnavailable, markBackendConnectionReady } = await import('../config/backendConnectionState');
  let finishOld!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ global: true, mode: 'trust' })));
  vi.stubGlobal('fetch', fetchMock);
  const base = '/api/backend-connections/permission-generation/proxy';
  render(<Probe base={base} />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  act(() => { markBackendConnectionUnavailable('permission-generation'); markBackendConnectionReady('permission-generation'); });
  await waitFor(() => expect(screen.getByText(`${base}:true:trust`)).toBeTruthy());
  await act(async () => { finishOld(new Response(JSON.stringify({ global: true, mode: 'yolo' }))); });
  expect(screen.getByText(`${base}:true:trust`)).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
