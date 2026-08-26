import { describe, expect, it } from 'vitest';
import type { AgentRuntimeOption } from '../services/api';
import { filterVisibleRuntimes } from './runtimeVisibility';

const runtimes: AgentRuntimeOption[] = [
  { id: 'kiro', label: 'Kiro', available: true },
  { id: 'claude', label: 'Claude', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Pi', available: true },
  { id: 'cursor', label: 'Cursor', available: true },
  { id: 'grok', label: 'Grok', available: true },
  { id: 'antigravity', label: 'Antigravity', available: false },
];

describe('filterVisibleRuntimes', () => {
  it('leaves public builds unfiltered', () => {
    expect(filterVisibleRuntimes(runtimes, false).map((runtime) => runtime.id)).toEqual(
      runtimes.map((runtime) => runtime.id),
    );
  });

  it('only exposes Kiro, Claude, Codex, and Pi in Restricted builds', () => {
    expect(filterVisibleRuntimes(runtimes, true).map((runtime) => runtime.id)).toEqual([
      'kiro',
      'claude',
      'codex',
      'pi',
    ]);
  });

  it('returns a new array without mutating the backend status payload', () => {
    const before = [...runtimes];
    const result = filterVisibleRuntimes(runtimes, true);

    expect(result).not.toBe(runtimes);
    expect(runtimes).toEqual(before);
  });
});
