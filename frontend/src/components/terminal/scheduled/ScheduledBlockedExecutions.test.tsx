import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '../../ui/ConfirmDialog';
import { ScheduledBlockedExecutions } from './ScheduledBlockedExecutions';

const state = vi.hoisted(() => ({ confirmStopped: vi.fn() }));
vi.mock('../../../services/api/scheduledJobs', () => ({
  confirmScheduledExecutionStopped: (...args: unknown[]) => state.confirmStopped(...args),
}));
beforeEach(() => { state.confirmStopped.mockReset(); });

const execution = { runId: 'old-run', jobId: 'deleted-job', workspaceId: 'ws-1', reason: 'unconfirmed_executor', since: 1 };

function Recovery({ refresh = async () => {} }: { refresh?: () => Promise<void> }) {
  return <><ConfirmDialogHost /><ScheduledBlockedExecutions executions={[execution]} jobs={[]}
    workspaceName={() => 'michi'} now={100_000} onReleased={refresh} /></>;
}

describe('Scheduled blocked execution confirmation', () => {
  it('uses the shared dialog and performs no release when cancelled', async () => {
    render(<Recovery />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stopped: Previous scheduled job' }));
    const dialog = screen.getByRole('dialog', { name: 'Confirm the previous execution has stopped?' });
    expect(within(dialog).getByText(/Only continue after you have verified both have stopped/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Confirm stopped: Previous scheduled job' }) as HTMLButtonElement).disabled).toBe(false));
    expect(state.confirmStopped).not.toHaveBeenCalled();
  });

  it('preserves a conflict and returns focus to Retry after a confirmed request fails', async () => {
    state.confirmStopped.mockRejectedValue(new Error('The previous Michi process is still running. Stop it and its agent before confirming.'));
    const refresh = vi.fn(async () => {});
    render(<Recovery refresh={refresh} />);
    const opener = screen.getByRole('button', { name: 'Confirm stopped: Previous scheduled job' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Both have stopped' }));
    const retry = await screen.findByRole('button', { name: 'Retry confirming stopped: Previous scheduled job' });
    expect(screen.getByText(/The previous Michi process is still running/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(retry));
    expect(state.confirmStopped).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('waits for the release and refresh before enabling another confirmation', async () => {
    let release!: (value: { released: true }) => void;
    state.confirmStopped.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const refresh = vi.fn(async () => {});
    render(<Recovery refresh={refresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm stopped: Previous scheduled job' }));
    fireEvent.click(screen.getByRole('button', { name: 'Both have stopped' }));
    await waitFor(() => expect(state.confirmStopped).toHaveBeenCalledWith('old-run'));
    expect((screen.getByRole('button', { name: 'Confirm stopped: Previous scheduled job' }) as HTMLButtonElement).disabled).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    release({ released: true });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await waitFor(() => expect((screen.getByRole('button', { name: 'Confirm stopped: Previous scheduled job' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
