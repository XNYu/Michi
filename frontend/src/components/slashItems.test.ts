import { matchSlashContext, buildSlashItems, buildAgentItems } from './slashItems';
import type { AgentCommand, SessionMode } from '../services/api';

describe('buildSlashItems', () => {
  it("drops an agent command whose name collides with a local (local wins)", () => {
    const agent: AgentCommand[] = [
      { name: 'branch', description: 'This would shadow /branch' },
      { name: 'kiro-only', description: 'unique' },
    ];
    const items = buildSlashItems(agent, '');
    const branches = items.filter((i) => i.name === 'branch');
    expect(branches).toHaveLength(1);
    expect(branches[0].source).toBe('local');
    expect(items.find((i) => i.name === 'kiro-only')?.source).toBe('runtime');
  });
});

describe('matchSlashContext agent sub-picker', () => {
  it('matches /agent with trailing space (empty query)', () => {
    expect(matchSlashContext('/agent ', 7)).toEqual({ query: '', command: 'agent' });
  });
});

describe('buildAgentItems', () => {
  const modes: SessionMode[] = [
    { id: 'explorer', name: 'explorer', description: 'Codebase exploration' },
    { id: 'planner', name: 'planner', description: 'Work breakdown' },
    { id: 'reviewer', name: 'reviewer' },
  ];
  const current = 'explorer';

  it('returns [] when availableModes is undefined', () => {
    expect(buildAgentItems(undefined, current, '')).toEqual([]);
  });

  it('maps every available mode to an item with source="agent" and modeId', () => {
    const items = buildAgentItems(modes, current, '');
    expect(items.map((i) => i.name)).toEqual(['explorer', 'planner', 'reviewer']);
    expect(items.every((i) => i.source === 'agent')).toBe(true);
    expect(items.every((i) => i.takesArgs === false)).toBe(true);
    expect(items.find((i) => i.name === 'explorer')?.modeId).toBe('explorer');
  });

  it('filters by query (prefix ranks above substring)', () => {
    const items = buildAgentItems(modes, current, 're');
    const names = items.map((i) => i.name);
    // 'reviewer' prefix-matches; 'explorer' substring-matches.
    expect(names.indexOf('reviewer')).toBeLessThan(names.indexOf('explorer'));
  });
});
