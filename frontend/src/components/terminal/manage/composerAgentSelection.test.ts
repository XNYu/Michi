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
});
