import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundPane } from './BackgroundPane';
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
