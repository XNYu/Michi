import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { HomeSectionItem } from 'michi-shared';
import { HomeSectionBlock } from './HomeSections';
const mocks = vi.hoisted(() => ({ act: vi.fn(), notify: vi.fn() }));
vi.mock('../../../../services/api/spacesHome', () => ({ actOnHomeReminder: mocks.act }));
vi.mock('../../../../state/pages/pageEvents', () => ({ notifyPageChanged: mocks.notify }));
vi.mock('./homeCounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./homeCounts')>()),
  useOpenedDoneKey: () => '',
}));
const item: HomeSectionItem = { id: 'conversation:n', kind: 'conversation', workspaceId: 'w', workspaceName: 'Work', title: 'Failed run', at: 1, summary: 'Failed', agentClaim: false, reminderVersion: 'v1', target: { kind: 'conversation', nodeId: 'n', workspaceId: 'w', messageId: null } };
beforeEach(() => { vi.clearAllMocks(); mocks.act.mockResolvedValue(undefined); });
it('persists a reminder action on its backend, refreshes counts and supports undo', async () => {
  render(<HomeSectionBlock section="waiting" connectionId="remote" data={{ items: [item], total: 1 }} clock={2} onAct={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Remind tomorrow: Failed run' }));
  await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith({ backendConnectionId: 'remote' }));
  expect(mocks.act).toHaveBeenCalledWith('remote', item, 'snooze');
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
  await waitFor(() => expect(mocks.act).toHaveBeenLastCalledWith('remote', item, 'restore'));
});
it('keeps the reminder and reports failed writes without a success message', async () => {
  mocks.act.mockRejectedValue(new Error('Offline'));
  render(<HomeSectionBlock section="waiting" connectionId="local" data={{ items: [item], total: 1 }} clock={2} onAct={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'No longer needs attention: Failed run' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Offline');
  expect(mocks.notify).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
});
