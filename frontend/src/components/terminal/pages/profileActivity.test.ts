import { buildProfileActivity } from './profileActivity';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

const atNoon = (date: string) => new Date(`${date}T12:00:00`).getTime();

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Project',
    chatIds: ['root', 'child', 'digest'],
    edges: [{ source: 'root', target: 'child', kind: 'branch' }],
    createdAt: atNoon('2026-01-01'),
    trees: [{ id: 't1', rootNodeId: 'root', createdAt: atNoon('2026-01-01'), lastActiveAt: atNoon('2026-05-25') }],
    activeTreeId: 't1',
    contexts: [],
    ...overrides,
  };
}

function node(overrides: Partial<ChatNodeState>): ChatNodeState {
  return {
    nodeId: 'root',
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages: [],
    followUps: [],
    status: 'idle',
    ...overrides,
  };
}

describe('buildProfileActivity', () => {
  it('aggregates real node, branch, and estimated-token activity', () => {
    const activity = buildProfileActivity(
      [project()],
      {
        root: node({
          nodeId: 'root',
          messages: [
            { id: 'u1', role: 'user', text: 'hello world', toolCalls: [], createdAt: atNoon('2026-05-24') },
          ],
        }),
        child: node({
          nodeId: 'child',
          parentNodeId: 'root',
          messages: [
            { id: 'u2', role: 'user', text: 'abcdefgh', toolCalls: [], createdAt: atNoon('2026-05-25') },
          ],
        }),
        digest: node({
          nodeId: 'digest',
          kind: 'digest',
          messages: [
            { id: 'u3', role: 'user', text: 'ignored', toolCalls: [], createdAt: atNoon('2026-05-25') },
          ],
        }),
      },
      atNoon('2026-05-25'),
    );

    expect(activity.totalNodes).toBe(2);
    expect(activity.totalThreads).toBe(1);
    expect(activity.totalBranches).toBe(1);

    expect(activity.metrics.nodes.total).toBe(2);
    expect(activity.metrics.branches.total).toBe(1);
    expect(activity.metrics.tokens.total).toBe(5);
    expect(activity.metrics.nodes.longestStreak).toBe(2);
    expect(activity.metrics.nodes.currentStreak).toBe(2);

    const nodesByDate = new Map(activity.metrics.nodes.cells.map((cell) => [cell.dateKey, cell]));
    const branchesByDate = new Map(activity.metrics.branches.cells.map((cell) => [cell.dateKey, cell]));

    expect(nodesByDate.get('2026-05-24')?.count).toBe(1);
    expect(nodesByDate.get('2026-05-25')?.count).toBe(1);
    expect(branchesByDate.get('2026-05-25')?.count).toBe(1);
    expect(nodesByDate.get('2026-05-26')?.isFuture).toBe(true);
  });

  it('falls back to the workspace created date for legacy messages without timestamps', () => {
    const activity = buildProfileActivity(
      [project({ createdAt: atNoon('2026-04-10') })],
      {
        root: node({
          nodeId: 'root',
          messages: [
            { id: 'legacy', role: 'user', text: 'legacy message', toolCalls: [] },
          ],
        }),
      },
      atNoon('2026-05-25'),
    );

    const nodesByDate = new Map(activity.metrics.nodes.cells.map((cell) => [cell.dateKey, cell]));
    expect(nodesByDate.get('2026-04-10')?.count).toBe(1);
  });
});
