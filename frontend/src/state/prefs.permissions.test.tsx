import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrefsProvider, usePrefs } from './prefs';

const api = vi.hoisted(() => ({ fetchPrefs: vi.fn(), savePrefs: vi.fn(), savePermissionSettings: vi.fn() }));
vi.mock('../services/api', () => ({ fetchPrefs: api.fetchPrefs, savePrefs: api.savePrefs }));
vi.mock('../services/api/prefs', () => ({ savePermissionSettings: api.savePermissionSettings }));
function Probe() {
  const { prefs, setPermissionSettings } = usePrefs();
  return <>
    <output>{`${prefs.globalPermissions}:${prefs.permissionMode}`}</output>
    <button onClick={() => { void setPermissionSettings({ global: true, mode: 'yolo' }).catch(() => {}); }}>Global YOLO</button>
  </>;
}
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  api.fetchPrefs.mockResolvedValue(null); api.savePrefs.mockResolvedValue(undefined);
});
afterEach(cleanup);
it('migrates the former renderer bypass to global Trust rather than full access', () => {
  localStorage.setItem('michi:v1:prefs', JSON.stringify({ bypassPermissions: true }));
  render(<PrefsProvider><Probe /></PrefsProvider>);
  expect(screen.getByText('true:trust')).toBeTruthy();
});
it('backend permission settings override stale local permission preferences', async () => {
  localStorage.setItem('michi:v1:prefs', JSON.stringify({ globalPermissions: true, permissionMode: 'yolo' }));
  api.fetchPrefs.mockResolvedValue({ globalPermissions: false, permissionMode: 'ask' });
  render(<PrefsProvider><Probe /></PrefsProvider>);
  await waitFor(() => expect(screen.getByText('false:ask')).toBeTruthy());
});
it('only changes the visible global mode after the backend acknowledges the save', async () => {
  let resolve!: (value: unknown) => void;
  api.savePermissionSettings.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<PrefsProvider><Probe /></PrefsProvider>);
  fireEvent.click(screen.getByText('Global YOLO'));
  expect(screen.getByText('false:ask')).toBeTruthy();
  await act(async () => { resolve({ global: true, mode: 'yolo' }); });
  expect(screen.getByText('true:yolo')).toBeTruthy();
});
it('failed permission saves retain the previous effective UI mode', async () => {
  api.savePermissionSettings.mockRejectedValue(new Error('offline'));
  render(<PrefsProvider><Probe /></PrefsProvider>);
  await act(async () => { fireEvent.click(screen.getByText('Global YOLO')); });
  expect(screen.getByText('false:ask')).toBeTruthy();
});
it('another window changing permissions refreshes the authoritative backend selection', async () => {
  render(<PrefsProvider><Probe /></PrefsProvider>);
  await act(async () => { await Promise.resolve(); });
  api.fetchPrefs.mockResolvedValue({ globalPermissions: true, permissionMode: 'trust' });
  await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'michi:v1:prefs' })); });
  expect(screen.getByText('true:trust')).toBeTruthy();
});
