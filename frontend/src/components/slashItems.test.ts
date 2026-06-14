import { matchSlashContext, buildSlashItems, buildAgentItems } from './slashItems';
import type { AgentCommand, SessionMode } from '../services/api';

describe('matchSlashContext', () => {
  it('opens on a lone slash at position 0', () => {
    expect(matchSlashContext('/', 1)).toEqual({ query: '' });
  });

  it('extracts the query after the slash', () => {
    expect(matchSlashContext('/fan', 4)).toEqual({ query: 'fan' });
  });

  it('allows hyphens in command names', () => {
    expect(matchSlashContext('/fan-out', 8)).toEqual({ query: 'fan-out' });
  });

  it('closes once a space appears (user is typing args)', () => {
    expect(matchSlashContext('/branch hello', 13)).toBeNull();
  });

  it('closes on a newline after the command', () => {
    expect(matchSlashContext('/branch\nmore', 12)).toBeNull();
  });

  it('does not open on mid-sentence slashes (e.g. URLs)', () => {
    expect(matchSlashContext('look at https://x.com/y', 22)).toBeNull();
  });

  it('does not open on text that merely contains a slash after char 0', () => {
    expect(matchSlashContext('fix the /etc file', 17)).toBeNull();
  });
});

describe('buildSlashItems', () => {
  it('returns all local commands with no query and no agent commands', () => {
    const items = buildSlashItems(undefined, '');
    const names = items.map((i) => i.name);
    expect(names).toEqual(['agent', 'branch', 'btw', 'fanout', 'fan-out', 'explore']);
    expect(items.every((i) => i.source === 'local')).toBe(true);
  });

  it('merges agent commands after locals', () => {
    const agent: AgentCommand[] = [
      { name: 'compact', description: 'Compact the conversation' },
      { name: 'mode', description: 'Switch operating mode' },
    ];
    const items = buildSlashItems(agent, '');
    const names = items.map((i) => i.name);
    expect(names).toEqual([
      'agent', 'branch', 'btw', 'fanout', 'fan-out', 'explore',
      'compact', 'mode',
    ]);
    expect(items.find((i) => i.name === 'compact')?.source).toBe('kiro');
  });

  it("drops an agent command whose name collides with a local (local wins)", () => {
    const agent: AgentCommand[] = [
      { name: 'branch', description: 'This would shadow /branch' },
      { name: 'kiro-only', description: 'unique' },
    ];
    const items = buildSlashItems(agent, '');
    const branches = items.filter((i) => i.name === 'branch');
    expect(branches).toHaveLength(1);
    expect(branches[0].source).toBe('local');
    expect(items.find((i) => i.name === 'kiro-only')?.source).toBe('kiro');
  });

  it('prefix matches rank above substring matches', () => {
    // 'fa' prefix-matches fanout/fan-out, and substring-matches nothing else.
    // Add an agent command with 'fa' as a substring (not prefix) to confirm
    // the ordering invariant: prefix hits always come first.
    const agent: AgentCommand[] = [
      { name: 'refactor' }, // 'fa' appears in the middle
    ];
    const items = buildSlashItems(agent, 'fa');
    const names = items.map((i) => i.name);
    const refactorIdx = names.indexOf('refactor');
    const fanoutIdx = names.indexOf('fanout');
    expect(fanoutIdx).toBeGreaterThanOrEqual(0);
    expect(refactorIdx).toBeGreaterThanOrEqual(0);
    expect(fanoutIdx).toBeLessThan(refactorIdx);
  });

  it('empty query returns everything', () => {
    const items = buildSlashItems(undefined, '');
    expect(items).toHaveLength(6);
  });

  it('filters out non-matching items', () => {
    const items = buildSlashItems(undefined, 'branch');
    expect(items.map((i) => i.name)).toEqual(['branch']);
  });

  it('marks agent commands with input spec as taking args', () => {
    const agent: AgentCommand[] = [
      { name: 'noarg' },
      { name: 'witharg', input: { type: 'unstructured' } },
    ];
    const items = buildSlashItems(agent, '');
    expect(items.find((i) => i.name === 'noarg')?.takesArgs).toBe(false);
    expect(items.find((i) => i.name === 'witharg')?.takesArgs).toBe(true);
  });
});


describe('matchSlashContext agent sub-picker', () => {
  it('matches /agent <query> for sub-picker', () => {
    expect(matchSlashContext('/agent plan', 11)).toEqual({ query: 'plan', command: 'agent' });
  });

  it('matches /agent with trailing space (empty query)', () => {
    expect(matchSlashContext('/agent ', 7)).toEqual({ query: '', command: 'agent' });
  });

  it('does not trigger sub-picker for unknown commands', () => {
    expect(matchSlashContext('/branch foo', 11)).toBeNull();
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

  it('returns [] when availableModes is empty', () => {
    expect(buildAgentItems([], current, '')).toEqual([]);
  });

  it('maps every available mode to an item with source="agent" and modeId', () => {
    const items = buildAgentItems(modes, current, '');
    expect(items.map((i) => i.name)).toEqual(['explorer', 'planner', 'reviewer']);
    expect(items.every((i) => i.source === 'agent')).toBe(true);
    expect(items.every((i) => i.takesArgs === false)).toBe(true);
    expect(items.find((i) => i.name === 'explorer')?.modeId).toBe('explorer');
  });

  it("marks the currently-active mode's description", () => {
    const items = buildAgentItems(modes, current, '');
    const c = items.find((i) => i.name === 'explorer');
    expect(c?.description).toMatch(/current/);
  });

  it('tolerates null currentModeId (no current marker on any item)', () => {
    const items = buildAgentItems(modes, null, '');
    expect(items.every((i) => !/current/.test(i.description ?? ''))).toBe(true);
  });

  it('filters by query (prefix ranks above substring)', () => {
    const items = buildAgentItems(modes, current, 're');
    const names = items.map((i) => i.name);
    // 'reviewer' prefix-matches; 'explorer' substring-matches.
    expect(names.indexOf('reviewer')).toBeLessThan(names.indexOf('explorer'));
  });
});
