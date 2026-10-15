import { describe, expect, it } from 'vitest';
import { composerModelLabel } from './composerModelLabel';

describe('composerModelLabel', () => {
  it.each([
    ['global.anthropic.claude-opus-5-5[1m]', 'Opus 5.5 (1M)'],
    ['us.anthropic.claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-opus-5[1m]', 'Opus 5 (1M)'],
    ['sonnet', 'Sonnet'],
  ])('formats %s without a loaded catalog', (id, label) => {
    expect(composerModelLabel('claude', id, [])).toBe(label);
  });

  it('resolves a default CLI entry to the concrete model name', () => {
    const id = 'claude-opus-5-5[1m]';
    expect(composerModelLabel('claude', id, [{ id, label: 'Default' }])).toBe('Opus 5.5 (1M)');
  });

  it('keeps catalog labels, other runtimes and unknown model IDs', () => {
    expect(composerModelLabel('claude', 'claude-sonnet-4-6', [{ id: 'claude-sonnet-4-6', label: 'Sonnet (recommended)' }])).toBe('Sonnet (recommended)');
    expect(composerModelLabel('pi', 'anthropic/claude-sonnet-4-6', [])).toBe('anthropic/claude-sonnet-4-6');
    expect(composerModelLabel('claude', 'custom-model', [])).toBe('custom-model');
    expect(composerModelLabel('claude', undefined, [])).toBe('Default model');
  });
});
