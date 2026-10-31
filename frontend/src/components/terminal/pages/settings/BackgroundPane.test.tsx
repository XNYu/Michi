import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundPane } from './BackgroundPane';
import { SettingsLayoutContext } from './settingsPhone';
const api = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../../../../services/api/scheduledJobs', () => ({
  getScheduledJobSettings: async () => ({ sessionMode: 'persistent' }),
  updateScheduledJobSettings: (...args: unknown[]) => api.save(...args),
}));
vi.mock('../../scheduled/useBackgroundService', () => ({ useBackgroundService: () => ({ available: false }) }));
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
  });
});
