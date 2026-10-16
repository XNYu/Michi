import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteRecoveryBanner } from './RemoteRecoveryBanner';
import { clearRemoteRecoveryIssue, getRemoteRecoveryIssues, reportRemoteRecoveryFailure } from '../state/remoteRecovery';

vi.mock('../services/api/agentRuntime', () => ({ fetchAgentStatus: vi.fn().mockResolvedValue({ runtime: 'none', availableRuntimes: [], hasRequiredKey: false }) }));
const remote = { id: 'c', name: 'build+', sshHost: 'build+', transport: 'ssh' as const, hasToken: true, createdAt: 1, updatedAt: 1 };
afterEach(() => {
  for (const issue of getRemoteRecoveryIssues()) clearRemoteRecoveryIssue(issue.connectionId);
  vi.unstubAllGlobals();
});

it('keeps the error visible through retries, copies redacted history and clears only the recovered machine', async () => {
  const copy = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
  reportRemoteRecoveryFailure(remote, new Error('SSH authentication expired. Bearer private-value'));
  render(<RemoteRecoveryBanner />);
  await screen.findByText('No ready local runtime. View or copy diagnostics below.');
  expect(screen.getByText(/Reconnecting to build\+/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'View logs' }));
  act(() => { reportRemoteRecoveryFailure(remote, new Error('VPN unavailable')); });
  expect((screen.getByLabelText('Connection log') as HTMLTextAreaElement).value).toContain('attempt 2');
  fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
  await screen.findByText('Diagnostics copied.');
  expect(copy.mock.calls[0][0]).toContain('VPN unavailable');
  expect(copy.mock.calls[0][0]).not.toContain('private-value');
  act(() => { reportRemoteRecoveryFailure({ ...remote, id: 'other', name: 'Other' }, new Error('offline')); clearRemoteRecoveryIssue('c'); });
  expect(screen.queryByText(/Reconnecting to build\+/)).toBeNull();
  expect(screen.getByText('Reconnecting to Other')).toBeTruthy();
});

it('bounds repeated failure logs and labels truncation', () => {
  for (let i = 0; i < 10; i++) reportRemoteRecoveryFailure(remote, new Error('x'.repeat(5000)));
  const report = getRemoteRecoveryIssues()[0].diagnostic;
  expect(report.log.length).toBeLessThanOrEqual(32_000);
  expect(report.truncated).toBe(true);
  expect(report.log).toContain('attempt 10');
});
