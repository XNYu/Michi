import { describe, expect, it } from 'vitest';
import type { AgentRuntimeOption } from '../services/api';
import { filterVisibleRuntimes } from './runtimeVisibility';

const runtimes: AgentRuntimeOption[] = [
  { id: 'kiro', label: 'Kiro', available: true },
  { id: 'crew', label: 'Kiro Crew', available: false },
  { id: 'claude', label: 'Claude', available: true },
  { id: 'codex', label: 'Codex', available: true },
  { id: 'pi', label: 'Pi', available: true },
  { id: 'cursor', label: 'Cursor', available: true },
  { id: 'grok', label: 'Grok', available: true },
  { id: 'antigravity', label: 'Antigravity', available: false },
];

describe('filterVisibleRuntimes', () => {
  it('offers available runtimes in public builds', () => {
    expect(filterVisibleRuntimes(runtimes, false).map((runtime) => runtime.id)).toEqual(
      ['claude', 'codex', 'cursor', 'grok', 'kiro', 'pi'],
    );
  });

  it('applies availability and the internal allowlist together', () => {
    expect(filterVisibleRuntimes(runtimes, true).map((runtime) => runtime.id)).toEqual(['claude', 'codex', 'kiro', 'pi']);
    expect(runtimes.find((runtime) => runtime.id === 'crew')?.available).toBe(false);
  });

  it('keeps Antigravity visible in Restricted builds when available', () => {
    const available = runtimes.map((runtime) => runtime.id === 'antigravity' ? { ...runtime, available: true } : runtime);
    expect(filterVisibleRuntimes(available, true).map((runtime) => runtime.id)).toEqual(['antigravity', 'claude', 'codex', 'kiro', 'pi']);
  });
});
