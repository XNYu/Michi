import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MaintenanceEnrollmentCheckbox, MaintenanceStatus } from './MaintenanceStatus';

const state = vi.hoisted(() => ({
  maintenance: {
    value: null as any,
    loading: false,
    busy: false,
    error: null as string | null,
    refresh: vi.fn(),
    update: vi.fn(async () => undefined),
    setSpaceExcluded: vi.fn(async () => undefined),
    runNow: vi.fn(async () => undefined),
    reconsider: vi.fn(async () => undefined),
    catchUp: vi.fn(async (_spaceId: string, after: number, through: number) => ({ requestId: 'queued', after, through, queued: true as const })),
  },
}));

vi.mock('../../../state/pages/usePageMaintenance', () => ({
  usePageMaintenance: () => state.maintenance,
}));

describe('MaintenanceEnrollmentCheckbox', () => {
  it('keeps the checked-by-default choice controlled by the create form', () => {
    const change = vi.fn();
    render(<MaintenanceEnrollmentCheckbox checked onChange={change} />);
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    fireEvent.click(checkbox);
    expect(change).toHaveBeenCalledWith(false);
    expect(screen.getByText(/Existing pages are not enrolled automatically/)).toBeTruthy();
  });
});

describe('MaintenanceStatus', () => {
  it('shows enrollment as not enabled before a workspace config exists', () => {
    state.maintenance.value = {
      config: null,
      status: null,
      backlog: { plans: [], pendingSources: 0, attentionSources: 0 },
      job: null,
      scheduler: 'available',
      excludedSpaceIds: [],
    };
    render(<MaintenanceStatus backendConnectionId="local" workspaceId="w1" />);
    expect(screen.getByRole('heading', { name: 'Not enabled' })).toBeTruthy();
    expect(screen.getByText(/Older conversations are not read automatically/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('names the Meta agent runtime maintenance runs on and links to its settings', () => {
    state.maintenance.value = {
      config: { workspaceId: 'w1', ownerUserId: 'u1', jobId: 'j1', enabled: true, paused: false, revision: 4, completionCursor: 5, runtimeId: null, providerId: null, modelId: null, reasoning: null, updatedAt: 1 },
      status: null,
      backlog: { plans: [], pendingSources: 0, attentionSources: 0 },
      job: { id: 'j1', enabled: true, autoPaused: false, activeRunId: null },
      scheduler: 'available', excludedSpaceIds: [],
      runtime: { runtimeId: 'claude', providerId: null, modelId: 'claude-opus-5.5', reasoning: 'high', followsGlobal: true },
    };
    const sections: string[] = [];
    const pages: string[] = [];
    const onSection = (event: Event) => sections.push((event as CustomEvent<{ section: string }>).detail.section);
    const onPage = (event: Event) => pages.push((event as CustomEvent<{ page: string }>).detail.page);
    window.addEventListener('michi:open-settings-section', onSection);
    window.addEventListener('michi:nav-page', onPage);
    try {
      const { unmount } = render(<MaintenanceStatus backendConnectionId="local" workspaceId="w1" />);
      expect(screen.getByText(/Runs on the Meta agent: Claude · claude-opus-5.5 \(follows global\)/)).toBeTruthy();
      expect(screen.queryByText('Runtime profile')).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Runtime' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Change in Settings › Meta agent' }));
      expect(sections).toEqual(['meta-agent']);
      expect(pages).toEqual(['settings']);
      unmount();
      render(<MaintenanceStatus backendConnectionId="remote-a" workspaceId="w1" />);
      expect(screen.queryByRole('button', { name: 'Change in Settings › Meta agent' })).toBeNull();
      expect(screen.getByText(/set in Settings › Meta agent on that machine/)).toBeTruthy();
    } finally {
      window.removeEventListener('michi:open-settings-section', onSection);
      window.removeEventListener('michi:nav-page', onPage);
    }
  });

  it('enables updates without a runtime of its own', () => {
    state.maintenance.update.mockClear();
    state.maintenance.value = {
      config: { workspaceId: 'w1', ownerUserId: 'u1', jobId: 'j1', enabled: true, paused: true, revision: 4, completionCursor: 5, runtimeId: null, providerId: null, modelId: null, reasoning: null, updatedAt: 1 },
      status: null,
      backlog: { plans: [], pendingSources: 0, attentionSources: 0 },
      job: { id: 'j1', enabled: false, autoPaused: false, activeRunId: null },
      scheduler: 'paused', excludedSpaceIds: [],
    };
    render(<MaintenanceStatus backendConnectionId="local" workspaceId="w1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable updates' }));
    expect(state.maintenance.update).toHaveBeenCalledWith({ expectedRevision: 4, enabled: true, paused: false });
  });

  it('distinguishes conversations waiting to be read from proposals awaiting review', () => {
    state.maintenance.value = {
      config: { workspaceId: 'w1', ownerUserId: 'u1', jobId: 'j1', enabled: true, paused: false, revision: 2, completionCursor: 5, runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, updatedAt: 1 },
      status: { completionCounter: 7, lastRun: null, pendingSources: 2, attentionSources: 0 },
      backlog: { plans: [], pendingSources: 2, attentionSources: 0 },
      job: { id: 'j1', enabled: true, autoPaused: false, activeRunId: null, lastStatus: 'succeeded', lastRunAt: 1234 },
      scheduler: 'available', excludedSpaceIds: [],
    };
    render(<MaintenanceStatus backendConnectionId="local" workspaceId="w1" pendingProposals={3} />);
    expect(screen.getByRole('heading', { name: '2 new turns waiting' })).toBeTruthy();
    expect(screen.getByText(/Newly completed conversations are waiting to be read/)).toBeTruthy();
    expect(screen.getByText('3 suggestions waiting for review')).toBeTruthy();
    expect(screen.getByText(/Last run succeeded/)).toBeTruthy();
  });

  it('surfaces source attention and offers explicit reconsideration', () => {
    state.maintenance.value = {
      config: { workspaceId: 'w1', ownerUserId: 'u1', jobId: 'j1', enabled: true, paused: false, revision: 2, completionCursor: 5, runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, updatedAt: 1 },
      status: { completionCounter: 5, lastRun: null, pendingSources: 0, attentionSources: 1 },
      backlog: { plans: [{ id: 'p1', workspaceId: 'w1', ownerUserId: 'u1', jobId: 'j1', runId: null, configRevision: 2, generation: 1, reconsiderOfPlanId: null, after: 4, through: 5, state: 'attention', sources: [{ sourceTurnId: 't1', completionSeq: 5, evidence: { nodeId: 'n1', turnId: 't1', assistantId: 'a1' }, state: 'attention', routingComplete: false, manifest: [], candidates: [], terminalReason: 'Source is no longer readable' }], createdAt: 1, updatedAt: 1 }], pendingSources: 0, attentionSources: 1 },
      job: { id: 'j1', enabled: true, autoPaused: false, activeRunId: null, lastStatus: 'succeeded', lastRunAt: 1234 },
      scheduler: 'available', excludedSpaceIds: [],
    };
    render(<MaintenanceStatus backendConnectionId="local" workspaceId="w1" />);
    expect(screen.getByRole('heading', { name: 'Needs attention' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reconsider' }));
    expect(state.maintenance.reconsider).toHaveBeenCalledWith('p1', ['t1']);
  });

  it('shows a bounded cursor range and queues catch-up only for the selected Space', () => {
    state.maintenance.value = {
      config: { workspaceId: 'w1', ownerUserId: 'u1', jobId: 'j1', enabled: true, paused: false, revision: 2, completionCursor: 20, runtimeId: 'claude', providerId: null, modelId: null, reasoning: null, updatedAt: 1 },
      status: { completionCounter: 20, lastRun: null, pendingSources: 0, attentionSources: 0 },
      backlog: { plans: [], pendingSources: 0, attentionSources: 0 },
      job: { id: 'j1', enabled: true, autoPaused: false, activeRunId: null, lastStatus: 'succeeded', lastRunAt: 1234 },
      scheduler: 'available', excludedSpaceIds: [],
      catchUpSuggestions: [
        { periodId: 'period-for-space-1', spaceId: 'space-1', after: 10, through: 20, maxPositions: 1000, availablePositions: 10, excludedAt: 1, reenabledAt: 2, sourceCount: 1, latestSources: [{ turnId: 'turn-1', completionSeq: 20, completedAt: 2, preview: 'A conversation that was missed' }] },
        { periodId: 'period-for-space-2', spaceId: 'space-2', after: 5, through: 6, maxPositions: 1000, availablePositions: 1, excludedAt: 3, reenabledAt: 4, sourceCount: 1, latestSources: [{ turnId: 'turn-2', completionSeq: 6, completedAt: 4, preview: 'Another Space conversation' }] },
      ],
    };
    render(<MaintenanceStatus backendConnectionId="local" workspaceId="w1" spaceId="space-1" />);
    expect(screen.getByText(/completion positions 11–20 \(10 available/)).toBeTruthy();
    expect(screen.getByText(/A conversation that was missed/)).toBeTruthy();
    expect(screen.queryByText(/Another Space conversation/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Queue this period' }));
    expect(state.maintenance.catchUp).toHaveBeenCalledWith('space-1', 10, 20);
  });
});
