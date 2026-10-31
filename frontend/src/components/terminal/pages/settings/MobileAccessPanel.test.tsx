import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileAccessPanel } from './MobileAccessPanel';
import type { MobileAccessStatus } from 'michi-shared';
const mocks = vi.hoisted(() => ({ request: vi.fn(), link: vi.fn(), open: vi.fn(), confirm: vi.fn() }));
vi.mock('../../../../services/api/mobileAccess', () => ({ mobileAccessRequest: mocks.request, createMobileAccessLink: mocks.link }));
vi.mock('../../../../services/openUrl', () => ({ openExternalUrl: mocks.open }));
vi.mock('../../../ui/ConfirmDialog', () => ({ confirmDialog: mocks.confirm }));
const off: MobileAccessStatus = { state: 'stopped', url: '', error: '', available: true };
const connected: MobileAccessStatus = { ...off, state: 'connected', url: 'https://michi.tail123.ts.net' };
const connections = [{ id: 'box', name: 'Remote workstation', transport: 'ssh' as const, hasToken: true, createdAt: 1, updatedAt: 1 }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
beforeEach(() => { mocks.request.mockReset().mockResolvedValue(off); mocks.link.mockReset(); mocks.open.mockReset(); mocks.confirm.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

it('enables the selected machine, renders a local QR and removes an expired sign-in link', async () => {
  vi.useFakeTimers();
  mocks.request.mockImplementation(async (_id, action) => action === 'start' ? connected : off);
  mocks.link.mockResolvedValue({ url: connected.url + '/mobile-connect#fixture', expiresAt: Date.now() + 2000 });
  render(<MobileAccessPanel connections={connections} />); await act(async () => {});
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'box' } }); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Enable phone access' })); await act(async () => {});
  expect(mocks.request).toHaveBeenCalledWith('box', 'start');
  fireEvent.click(screen.getByRole('button', { name: 'Connect phone' })); await act(async () => {});
  expect(mocks.link).toHaveBeenCalledWith('box');
  expect(screen.getByRole('img', { name: 'Scan to connect to Michi' }).tagName.toLowerCase()).toBe('svg');
  expect(screen.queryByText(/#fixture/)).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(2001));
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText(/sign-in link expired/)).toBeTruthy();
});

it('keeps a reusable QR after the legacy deadline, copies the stable URL and removes it on stop', async () => {
  vi.useFakeTimers();
  mocks.request.mockImplementation(async (_id, action) => action === 'stop' ? off : connected);
  mocks.link.mockResolvedValue({ url: connected.url + '/', reusable: true, expiresAt: Date.now() + 2000 });
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  render(<MobileAccessPanel connections={connections} />); await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Connect phone' })); await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(screen.getByRole('img', { name: 'Scan to connect to Michi' })).toBeTruthy();
  expect(screen.getByText(/Reuse or bookmark/)).toBeTruthy();
  expect(screen.queryByText(/expires|expired|One use/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'New sign-in link' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Copy phone link' })); await act(async () => {});
  expect(copy).toHaveBeenCalledWith(connected.url + '/');
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' })); await act(async () => {});
  expect(screen.queryByRole('img')).toBeNull();
});

it('ignores old machine responses and invalidates the old QR immediately on switching', async () => {
  const pending = deferred<MobileAccessStatus>();
  mocks.request.mockImplementation(id => id === 'local' ? pending.promise : Promise.resolve(connected));
  render(<MobileAccessPanel connections={connections} />);
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'box' } });
  expect(await screen.findByText('Connected')).toBeTruthy();
  await act(async () => pending.resolve(off));
  expect(screen.getByText('Connected')).toBeTruthy();
  mocks.link.mockResolvedValue({ url: connected.url + '/mobile-connect#fixture', expiresAt: Date.now() + 300_000 });
  fireEvent.click(screen.getByRole('button', { name: 'Connect phone' }));
  await screen.findByRole('img');
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'local' } });
  expect(screen.queryByRole('img')).toBeNull();
  await act(async () => {});
});

it('an in-flight status poll cannot undo a completed stop', async () => {
  vi.useFakeTimers();
  const pending = deferred<MobileAccessStatus>();
  mocks.request.mockResolvedValueOnce(connected).mockImplementation((_id, action) => action === 'stop' ? Promise.resolve(off) : pending.promise);
  render(<MobileAccessPanel connections={connections} />); await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(3000));
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' })); await act(async () => {});
  await act(async () => pending.resolve(connected));
  expect(screen.getByText('Off')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect phone' })).toBeNull();
});

it('guides installation without enabling an unavailable Tailscale host', async () => {
  mocks.request.mockResolvedValue({ ...off, provider: 'tailscale', providers: ['tailscale'], available: false,
    tailscale: { state: 'not-installed', message: 'Install Tailscale on the machine running Michi.' } });
  render(<MobileAccessPanel connections={connections} />);
  const install = await screen.findByRole('button', { name: 'Install Tailscale on this machine' });
  expect((screen.getByRole('button', { name: 'Enable phone access' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(install);
  expect(mocks.open).toHaveBeenCalledWith('https://tailscale.com/download');
});

it('starts a Tailscale connection and hands sign-in to the external browser', async () => {
  const needsLogin = { ...off, provider: 'tailscale', tailscale: { state: 'needs-login' } };
  mocks.request.mockImplementation(async (_id, action) => action === 'login'
    ? { ...needsLogin, tailscale: { state: 'needs-login', actionUrl: 'https://login.tailscale.com/a/fixture' } } : needsLogin);
  render(<MobileAccessPanel connections={connections} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Connect Tailscale' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Continue Tailscale sign-in' }));
  expect(mocks.request).toHaveBeenCalledWith('local', 'login');
  expect(mocks.open).toHaveBeenCalledWith('https://login.tailscale.com/a/fixture');
});

it('keeps HTTPS consent visible and automatically shows a reusable QR only after Serve connects', async () => {
  vi.useFakeTimers();
  const pending = { ...off, provider: 'tailscale', state: 'starting', tailscale: { state: 'needs-approval', actionUrl: 'https://login.tailscale.com/f/serve?node=fixture' } };
  const ready = { ...connected, provider: 'tailscale', url: 'https://michi.tail123.ts.net', tailscale: { state: 'ready', account: 'owner@example.com' } };
  mocks.request.mockResolvedValue(pending);
  mocks.link.mockResolvedValue({ url: ready.url + '/', reusable: true, expiresAt: Date.now() + 1000 });
  render(<MobileAccessPanel connections={connections} />); await act(async () => {});
  expect(screen.getByRole('button', { name: 'Allow Tailscale HTTPS' })).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
  mocks.request.mockResolvedValue(ready);
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(mocks.link).toHaveBeenCalledWith('local');
  expect(screen.getByRole('img', { name: 'Scan to connect to Michi' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Allow Tailscale HTTPS' })).toBeNull();
  expect(screen.getByText(/owner@example.com/)).toBeTruthy();
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(screen.getByRole('img')).toBeTruthy();
});

it('a machine switch discards a pending QR from the old machine', async () => {
  const pending = deferred<{ url: string; reusable: boolean; expiresAt: number }>();
  const ready: MobileAccessStatus = { ...connected, provider: 'tailscale', providers: ['tailscale'], tailscale: { state: 'ready' } };
  mocks.request.mockImplementation(async id => id === 'local' ? ready : off);
  mocks.link.mockReturnValue(pending.promise);
  render(<MobileAccessPanel connections={connections} />);
  await screen.findByText('Connected');
  fireEvent.change(screen.getByLabelText('Machine'), { target: { value: 'box' } });
  await act(async () => {});
  await act(async () => pending.resolve({ url: 'https://old.tail123.ts.net/', reusable: true, expiresAt: 1 }));
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText('Off')).toBeTruthy();
});

it('asks before turning off the phone access this page was opened through, and stays on when declined', async () => {
  const here: MobileAccessStatus = { ...connected, url: window.location.origin };
  mocks.request.mockImplementation(async (_id, action) => action === 'stop' ? off : here);
  mocks.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<MobileAccessPanel connections={connections} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off' })); await act(async () => {});
  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Turn off phone access?', confirmLabel: 'Turn off' }));
  expect(mocks.request).not.toHaveBeenCalledWith('local', 'stop');
  expect(screen.getByText('Connected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' })); await act(async () => {});
  expect(mocks.request).toHaveBeenCalledWith('local', 'stop');
  expect(screen.getByText('Off')).toBeTruthy();
});

it('turns off phone access opened elsewhere without asking', async () => {
  mocks.request.mockImplementation(async (_id, action) => action === 'stop' ? off : connected);
  render(<MobileAccessPanel connections={connections} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Turn off' })); await act(async () => {});
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledWith('local', 'stop');
});
