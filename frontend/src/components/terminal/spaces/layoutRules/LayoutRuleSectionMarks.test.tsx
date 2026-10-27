import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageLayoutRule } from 'michi-shared';

const mocks = vi.hoisted(() => ({ remove: vi.fn(), notify: vi.fn() }));
vi.mock('../../../../services/api/spacesHome', () => ({ deleteLayoutRule: mocks.remove }));
vi.mock('../../../../state/pages/pageEvents', () => ({ notifyPageChanged: mocks.notify }));

import { LayoutRuleSectionMarks } from './LayoutRuleSectionMarks';

const NOW = 1_000_000_000;
const rule: PageLayoutRule = {
  id: 'rule-1', text: 'Stalled: only the last 3 days', createdBy: 'agent', createdAt: NOW - 1_000,
  sourceMessage: { nodeId: 'n', turnId: 't', messageId: 'm' }, sectionLimit: { section: 'stalled', maxAgeDays: 3 },
};
const other: PageLayoutRule = { ...rule, id: 'rule-2', text: 'Done: at most 2', createdBy: 'user', sectionLimit: { section: 'done', maxItems: 2 } };

describe('LayoutRuleSectionMarks', () => {
  beforeEach(() => {
    mocks.remove.mockReset().mockResolvedValue([]);
    mocks.notify.mockReset();
  });

  it('marks a section with the rules that shaped it, and Undo deletes the rule', async () => {
    render(<LayoutRuleSectionMarks pageId="pg-home" backendConnectionId="local" rules={[rule, other]} ruleIds={['rule-1']} now={NOW} />);
    const marks = screen.getAllByTestId('layout-rule-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].querySelector('time')).toBeNull();
    expect(marks[0].getAttribute('data-quiet')).toBe('true');
    expect(marks[0].textContent).toBe('Layout rule·from Assistant·Undo');
    expect(marks[0].getAttribute('title')).toBe('Layout rule: Stalled: only the last 3 days');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith({ backendConnectionId: 'local', pageId: 'pg-home' }));
    expect(mocks.remove).toHaveBeenCalledWith('pg-home', 'rule-1', 'local');
  });

  it('shows nothing for a section no rule shaped, and says a failed undo', async () => {
    const { container, rerender } = render(<LayoutRuleSectionMarks pageId="pg-home" backendConnectionId="local" rules={[rule]} ruleIds={undefined} now={NOW} />);
    expect(container.textContent).toBe('');
    mocks.remove.mockRejectedValueOnce(new Error('Page not found'));
    rerender(<LayoutRuleSectionMarks pageId="pg-home" backendConnectionId="local" rules={[other]} ruleIds={['rule-2']} now={NOW} />);
    expect(screen.getByTestId('layout-rule-mark').textContent).toContain('Layout rule·added by you');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't undo: Page not found"));
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
