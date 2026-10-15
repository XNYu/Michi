import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMPOSER_AGENT_SELECTION_STORAGE_KEY,
  clearComposerAgentSelections,
  readComposerModeSelection,
  readComposerPrimaryAgentSelection,
  writeComposerModeSelection,
  writeComposerPrimaryAgentSelection,
} from './composerAgentSelection';

const rawStored = () => localStorage.getItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY);
const stored = () => JSON.parse(rawStored()!);

describe('composer agent selection storage', () => {
  beforeEach(() => {
    clearComposerAgentSelections();
    localStorage.clear();
  });

  it('stores mode picks separately per Backend and runtime', () => {
    writeComposerModeSelection('local', 'kiro', 'planner');
    writeComposerModeSelection('local', 'claude', 'plan');

    expect(readComposerModeSelection('local', 'kiro')).toBe('planner');
    expect(readComposerModeSelection('local', 'claude')).toBe('plan');
    expect(readComposerModeSelection('remote-a', 'kiro')).toBeUndefined();
  });

  it('ignores reads and writes while the runtime is still unknown', () => {
    writeComposerModeSelection('local', undefined, 'planner');

    expect(readComposerModeSelection('local', undefined)).toBeUndefined();
    expect(rawStored()).toBeNull();
  });

  it('forgets a mode pick that is reset to the runtime default', () => {
    writeComposerModeSelection('local', 'kiro', 'planner');
    writeComposerModeSelection('local', 'kiro', undefined);

    expect(readComposerModeSelection('local', 'kiro')).toBeUndefined();
    expect(stored().modes).toEqual([]);
  });

  it('stores primary-agent picks per workspace as ids only', () => {
    writeComposerPrimaryAgentSelection('ws1', { backendConnectionId: 'local', definitionId: 'agent-1' });

    expect(readComposerPrimaryAgentSelection('ws1')).toEqual({ backendConnectionId: 'local', definitionId: 'agent-1' });
    expect(readComposerPrimaryAgentSelection('ws2')).toBeUndefined();
    expect(stored().primaryAgents).toEqual([['ws1', { backendConnectionId: 'local', definitionId: 'agent-1' }]]);

    writeComposerPrimaryAgentSelection('ws1', undefined);
    expect(readComposerPrimaryAgentSelection('ws1')).toBeUndefined();
  });

  it('reads corrupt or malformed storage as empty and recovers on the next write', () => {
    localStorage.setItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY, '{not json');
    expect(readComposerModeSelection('local', 'kiro')).toBeUndefined();

    // A valid entry whose value was corrupted to the wrong type.
    writeComposerModeSelection('local', 'kiro', 'planner');
    const corrupted = stored();
    corrupted.modes[0][1] = 7;
    corrupted.primaryAgents = [['ws1', { definitionId: 3 }], ['ws2', null], ['', { backendConnectionId: 'local', definitionId: 'x' }], 'junk'];
    localStorage.setItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY, JSON.stringify(corrupted));
    expect(readComposerModeSelection('local', 'kiro')).toBeUndefined();
    expect(readComposerPrimaryAgentSelection('ws1')).toBeUndefined();
    expect(readComposerPrimaryAgentSelection('ws2')).toBeUndefined();

    // An object map from an unknown writer is not trusted as pairs.
    localStorage.setItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY, JSON.stringify({ modes: { kiro: 'planner' }, primaryAgents: {} }));
    expect(readComposerModeSelection('local', 'kiro')).toBeUndefined();

    writeComposerModeSelection('local', 'kiro', 'build');
    expect(readComposerModeSelection('local', 'kiro')).toBe('build');
  });

  it('keeps entries written by another window', () => {
    writeComposerModeSelection('local', 'kiro', 'planner');
    writeComposerModeSelection('local', 'claude', 'plan');
    const otherWindowState = rawStored()!;

    // This window has only seen its own Kiro write; another window on the
    // same origin then saves both entries.
    clearComposerAgentSelections();
    writeComposerModeSelection('local', 'kiro', 'planner');
    localStorage.setItem(COMPOSER_AGENT_SELECTION_STORAGE_KEY, otherWindowState);

    writeComposerPrimaryAgentSelection('ws1', { backendConnectionId: 'local', definitionId: 'agent-1' });

    expect(readComposerModeSelection('local', 'kiro')).toBe('planner');
    expect(readComposerModeSelection('local', 'claude')).toBe('plan');
    expect(readComposerPrimaryAgentSelection('ws1')?.definitionId).toBe('agent-1');
  });

  it('evicts the least recently written entry when the cap is exceeded', () => {
    for (let index = 0; index < 60; index += 1) {
      writeComposerPrimaryAgentSelection(`ws-${index}`, { backendConnectionId: 'local', definitionId: `agent-${index}` });
    }
    expect(readComposerPrimaryAgentSelection('ws-9')).toBeUndefined();
    expect(readComposerPrimaryAgentSelection('ws-10')?.definitionId).toBe('agent-10');

    // Re-picking the oldest entry makes it the newest, so the next write evicts ws-11.
    writeComposerPrimaryAgentSelection('ws-10', { backendConnectionId: 'local', definitionId: 'agent-again' });
    writeComposerPrimaryAgentSelection('ws-60', { backendConnectionId: 'local', definitionId: 'agent-60' });

    expect(readComposerPrimaryAgentSelection('ws-10')?.definitionId).toBe('agent-again');
    expect(readComposerPrimaryAgentSelection('ws-11')).toBeUndefined();
    expect(readComposerPrimaryAgentSelection('ws-60')?.definitionId).toBe('agent-60');
    expect(stored().primaryAgents).toHaveLength(50);
  });
});
