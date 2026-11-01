import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundPane } from './BackgroundPane';
import { shouldShowLifetimeRows } from './desktopLifetime';
import { SettingsLayoutContext } from './settingsPhone';
const api = vi.hoisted(() => ({ save: vi.fn() }));
const lifetime = vi.hoisted(() => ({
  available: false,
  status: null as null | {
    supported: boolean;
    reason?: string;
    keepInBackground: boolean;
    openAtLogin: boolean;
    trayActive: boolean;
    canStartHidden: boolean;
  },
  busy: false,
  error: null as string | null,
  setKeepInBackground: vi.fn(),
  setOpenAtLogin: vi.fn(),
}));
vi.mock('../../../../services/api/scheduledJobs', () => ({
  getScheduledJobSettings: async () => ({ sessionMode: 'persistent' }),
  updateScheduledJobSettings: (...args: unknown[]) => api.save(...args),
}));
vi.mock('../../scheduled/useBackgroundService', () => ({ useBackgroundService: () => ({ available: false }) }));
vi.mock('../../scheduled/useDesktopLifetime', () => ({ useDesktopLifetime: () => lifetime }));
beforeEach(() => {
  lifetime.available = false;
  lifetime.status = null;
  lifetime.busy = false;
  lifetime.error = null;
  lifetime.setKeepInBackground.mockReset();
  lifetime.setOpenAtLogin.mockReset();
});
describe('scheduled job defaults', () => {
  it('loads and saves the default, retaining the saved value on failure', async () => {
    render(<BackgroundPane />);
    const ongoing = await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect((ongoing as HTMLInputElement).checked).toBe(true);
    api.save.mockResolvedValueOnce({ sessionMode: 'fresh' });
    fireEvent.click(screen.getByRole('radio', { name: 'New thread each run' }));
    await waitFor(() => expect((screen.getByRole('radio', { name: 'New thread each run' }) as HTMLInputElement).checked).toBe(true));
    expect(api.save).toHaveBeenCalledWith('fresh');
    api.save.mockRejectedValueOnce(new Error('Save failed'));
    fireEvent.click(ongoing);
    expect((await screen.findByRole('alert')).textContent).toContain('Save failed');
    expect((screen.getByRole('radio', { name: 'New thread each run' }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('background service on a phone', () => {
  it('links to the scheduled jobs instead of describing the desktop app’s service', async () => {
    const onOpenScheduled = vi.fn();
    render(<SettingsLayoutContext.Provider value="phone"><BackgroundPane onOpenScheduled={onOpenScheduled} /></SettingsLayoutContext.Provider>);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect(screen.queryByText('Keep Michi running in the background')).toBeNull();
    expect(screen.queryByText(/Your Mac still pauses Michi/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenScheduled).toHaveBeenCalledOnce();
  });

  it('keeps the service row on desktop', async () => {
    render(<BackgroundPane onOpenScheduled={vi.fn()} />);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect(screen.getByText('Keep Michi running in the background')).toBeTruthy();
    expect(screen.getByText('Available in the Michi desktop app.')).toBeTruthy();
    expect(screen.queryByText('Keep Michi in the system tray')).toBeNull();
    expect(screen.queryByText('Open Michi when I sign in')).toBeNull();
  });
});

describe('Windows lifetime rows', () => {
  const supported = {
    supported: true,
    keepInBackground: false,
    openAtLogin: false,
    trayActive: false,
    canStartHidden: false,
  };

  it('shows native tray and login switches when Windows lifetime is supported', async () => {
    lifetime.available = true;
    lifetime.status = supported;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<BackgroundPane />);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect(screen.getByRole('switch', { name: 'Keep Michi in the system tray' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Open Michi when I sign in' })).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Keep Michi in the system tray' }));
    await waitFor(() => expect(lifetime.setKeepInBackground).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('switch', { name: 'Open Michi when I sign in' }));
    await waitFor(() => expect(lifetime.setOpenAtLogin).toHaveBeenCalledWith(true));
  });

  it('clears unsupported Windows states without offering switches', async () => {
    lifetime.available = true;
    lifetime.status = {
      supported: false,
      reason: 'Tray background mode is available in the installed Windows app.',
      keepInBackground: false,
      openAtLogin: false,
      trayActive: false,
      canStartHidden: false,
    };
    render(<BackgroundPane />);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect(screen.getByText('Keep Michi in the system tray')).toBeTruthy();
    expect(screen.getAllByText('Tray background mode is available in the installed Windows app.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('switch', { name: 'Keep Michi in the system tray' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Open Michi when I sign in' })).toBeNull();
  });

  it('explains a failed tray so the user is not left with a hidden-looking On state', async () => {
    lifetime.available = true;
    lifetime.status = {
      supported: true,
      keepInBackground: true,
      openAtLogin: true,
      trayActive: false,
      canStartHidden: false,
    };
    render(<BackgroundPane />);
    await screen.findByRole('radio', { name: 'One ongoing thread' });
    expect(screen.getByText(/tray is unavailable/)).toBeTruthy();
    expect(screen.getByText(/stays visible unless the tray is working/)).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'Keep Michi in the system tray' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
  });
});

describe('lifetime row visibility', () => {
  it('hides browser, phone, and non-Windows unsupported states', () => {
    expect(shouldShowLifetimeRows(false, false, null)).toBe(false);
    expect(shouldShowLifetimeRows(true, true, { supported: true, keepInBackground: true, openAtLogin: false, trayActive: true, canStartHidden: true })).toBe(false);
    expect(shouldShowLifetimeRows(true, false, { supported: false, reason: 'Tray background mode is available on Windows.', keepInBackground: false, openAtLogin: false, trayActive: false, canStartHidden: false })).toBe(false);
    expect(shouldShowLifetimeRows(true, false, { supported: false, reason: 'Tray background mode is available in the installed Windows app.', keepInBackground: false, openAtLogin: false, trayActive: false, canStartHidden: false })).toBe(true);
    expect(shouldShowLifetimeRows(true, false, { supported: true, keepInBackground: false, openAtLogin: false, trayActive: false, canStartHidden: false })).toBe(true);
  });
});
