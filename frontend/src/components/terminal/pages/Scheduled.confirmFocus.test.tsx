import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScheduledJobDto } from 'michi-shared';
import { ConfirmDialogHost } from '../../ui/ConfirmDialog';
import TerminalScheduled from './Scheduled';

const state = vi.hoisted(() => ({ remove: vi.fn(), refresh: vi.fn(), removeLocal: vi.fn() }));
const job: ScheduledJobDto = {
  id: 'paused-job', workspaceId: 'ws-1', name: 'Paused job', prompt: 'Review changes',
  schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: null },
  runtimeId: null, providerId: null, modelId: null, reasoning: null, permissionMode: 'trust',
  sessionMode: 'fresh', notify: true, enabled: false, autoPaused: false, timeoutSeconds: 1800,
  nextRunAt: null, lastRunAt: null, lastStatus: null, lastError: null, consecutiveFailures: 0,
  activeRunId: null, persistentNodeId: null, createdAt: 1, updatedAt: 1,
};

vi.mock('../../../state/chatStore', () => ({
  useChatProjects: () => ({ projects: [{ id: 'ws-1', name: 'michi', chatIds: [], edges: [], trees: [], activeTreeId: null, createdAt: 1 }], activeProject: null, hydrated: true }),
  useChatActions: () => ({ revealBackendNode: vi.fn() }),
}));
vi.mock('../../../services/api/scheduledJobs', () => ({
  getScheduledJobSettings: async () => ({ sessionMode: 'persistent' }),
  deleteScheduledJob: (...args: unknown[]) => state.remove(...args),
}));
vi.mock('../scheduled/useScheduledJobs', () => ({
  useScheduledJobs: () => ({ jobs: [job], scheduler: { active: true, serviceMode: false, timezone: 'UTC' }, loading: false, error: null, unavailable: false, refresh: state.refresh, upsert: vi.fn(), remove: state.removeLocal }),
}));
vi.mock('../scheduled/useBackgroundService', () => ({
  useBackgroundService: () => ({ available: false, status: null, busy: false, error: null, setEnabled: vi.fn() }),
}));


beforeEach(() => {
  state.remove.mockReset();
  state.refresh.mockReset();
  state.refresh.mockResolvedValue(undefined);
  state.removeLocal.mockReset();
});

async function openDeleteFromMenu() {
  render(<><TerminalScheduled /><ConfirmDialogHost /></>);
  const trigger = screen.getByRole('button', { name: 'More actions for Paused job' });
  act(() => trigger.focus());
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'End' });
  const deleteItem = screen.getByRole('menuitem', { name: 'Delete…' });
  expect(document.activeElement).toBe(deleteItem);
  // Native Enter activation produces this click in Chromium.
  fireEvent.click(deleteItem);
  const dialog = await screen.findByRole('dialog', { name: 'Delete scheduled job?' });
  return { trigger, dialog };
}

describe('Scheduled menu confirmation focus', () => {
  it.each(['Escape', 'Cancel'])('returns focus to More actions after %s without deleting or disabling the trigger', async (dismiss) => {
    const { trigger, dialog } = await openDeleteFromMenu();
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' })));
    if (dismiss === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete scheduled job?' })).toBeNull());
    expect(document.activeElement).toBe(trigger);
    expect(state.remove).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open Paused job' })).toBeTruthy();
  });

  it('disables row actions only after the user confirms deletion', async () => {
    let finish!: () => void;
    state.remove.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { trigger, dialog } = await openDeleteFromMenu();
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete job' }));
    await waitFor(() => expect(state.remove).toHaveBeenCalledWith('paused-job'));
    expect((trigger as HTMLButtonElement).disabled).toBe(true);
    finish();
    await waitFor(() => expect(state.removeLocal).toHaveBeenCalledWith('paused-job'));
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  });
});
