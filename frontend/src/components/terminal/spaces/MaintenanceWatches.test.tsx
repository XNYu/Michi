import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceWatch } from 'michi-shared';
import type { PageMaintenanceState } from '../../../state/pages/usePageMaintenance';
import { MaintenanceWatches } from './MaintenanceWatches';

const CONFIG = { workspaceId: 'w1', ownerUserId: 'u1', jobId: 'j1', enabled: true, paused: false, revision: 2, completionCursor: 0,
  runtimeId: null, providerId: null, modelId: null, reasoning: null, updatedAt: 1 };

function watch(overrides: Partial<MaintenanceWatch> = {}): MaintenanceWatch {
  return { id: 'watch-1', title: 'Sev-2 tickets', instructions: 'Check open Sev-2 tickets', intervalMinutes: 30, enabled: true, revision: 3,
    pausedReason: null, runRequested: false, nextCheckAt: Date.parse('2099-01-01T10:00:00Z'),
    lastRun: { state: 'succeeded', startedAt: 1, finishedAt: 2, summary: 'Watch “Sev-2 tickets”: updated 2', error: null },
    createdAt: 1, updatedAt: 1, ...overrides };
}

function state(watches: MaintenanceWatch[] | undefined, instructions: string | null = null): PageMaintenanceState {
  return {
    value: { config: CONFIG, status: null, backlog: { plans: [], pendingSources: 0, attentionSources: 0 }, job: null, scheduler: 'available',
      excludedSpaceIds: [], ...(watches ? { watches } : {}),
      instructions: instructions === null ? null : { text: instructions, revision: 1, updatedAt: 1 } },
    loading: false, busy: false, error: null, refresh: vi.fn(),
    update: vi.fn(async () => undefined), setSpaceExcluded: vi.fn(async () => undefined), runNow: vi.fn(async () => undefined),
    reconsider: vi.fn(async () => undefined), catchUp: vi.fn(async () => ({ requestId: 'r', after: 0, through: 0, queued: true as const })),
    saveInstructions: vi.fn(async () => undefined), addWatch: vi.fn(async () => undefined), changeWatch: vi.fn(async () => undefined),
    removeWatch: vi.fn(async () => undefined), runWatch: vi.fn(async () => undefined),
  };
}

describe('MaintenanceWatches', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shows nothing for a backend that sends no watches', () => {
    const { container } = render(<MaintenanceWatches maintenance={state(undefined)} />);
    expect(container.innerHTML).toBe('');
  });

  it('lists a watch with its schedule and last check, and runs, turns off and deletes it', () => {
    const maintenance = state([watch()]);
    render(<MaintenanceWatches maintenance={maintenance} />);
    expect(screen.getByText('Sev-2 tickets')).toBeTruthy();
    expect(screen.getByText('Every 30 minutes')).toBeTruthy();
    expect(screen.getByText(/Last check .* · updated 2$/)).toBeTruthy();
    expect(screen.getByText(/^Next check /)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(maintenance.runWatch).toHaveBeenCalledWith('watch-1');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(maintenance.changeWatch).toHaveBeenCalledWith('watch-1', { enabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    expect(maintenance.removeWatch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete watch' }));
    expect(maintenance.removeWatch).toHaveBeenCalledWith('watch-1');
  });

  it('shows why a watch paused itself and offers to turn it back on', () => {
    const maintenance = state([watch({ enabled: false, nextCheckAt: null, pausedReason: 'Paused after 3 failed checks in a row: approval needed',
      lastRun: { state: 'failed', startedAt: 1, finishedAt: 2, summary: null, error: 'approval needed' } })]);
    render(<MaintenanceWatches maintenance={maintenance} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Paused after 3 failed checks/);
    expect((screen.getByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(maintenance.changeWatch).toHaveBeenCalledWith('watch-1', { enabled: true });
  });

  it('adds a watch from the form', () => {
    const maintenance = state([]);
    render(<MaintenanceWatches maintenance={maintenance} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a watch' }));
    const form = screen.getByRole('form', { name: 'New watch' });
    expect((screen.getByRole('button', { name: 'Add watch' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' My tasks ' } });
    fireEvent.change(screen.getByLabelText('What to check and where to record it'), { target: { value: 'Sync my project tasks' } });
    fireEvent.change(screen.getByLabelText('How often'), { target: { value: '240' } });
    fireEvent.submit(form);
    expect(maintenance.addWatch).toHaveBeenCalledWith({ title: 'My tasks', instructions: 'Sync my project tasks', intervalMinutes: 240 });
  });

  it('saves the workspace instructions only when they changed', () => {
    const maintenance = state([], 'Keep it short.');
    render(<MaintenanceWatches maintenance={maintenance} />);
    const save = screen.getByRole('button', { name: 'Save instructions' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Instructions for this workspace'), { target: { value: 'Every task names its owner.' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(maintenance.saveInstructions).toHaveBeenCalledWith('Every task names its owner.');
  });
});
