import { describe, it, expect } from 'vitest';

// Mirrors the sendMode derivation in TPane.tsx exactly.
type SendMode = 'send' | 'stop' | 'retry';

function deriveSendMode(opts: {
  streaming: boolean;
  isError: boolean;
  composerEmpty: boolean;
}): SendMode {
  const { streaming, isError, composerEmpty } = opts;
  return composerEmpty && streaming ? 'stop'
    : composerEmpty && isError ? 'retry'
    : 'send';
}

describe('sendMode derivation', () => {
  // --- send mode ---
  it('returns send when idle and composer is empty', () => {
    expect(deriveSendMode({ streaming: false, isError: false, composerEmpty: true })).toBe('send');
  });

  it('returns send when idle and composer has text', () => {
    expect(deriveSendMode({ streaming: false, isError: false, composerEmpty: false })).toBe('send');
  });

  it('returns send when streaming and composer has text (queue)', () => {
    expect(deriveSendMode({ streaming: true, isError: false, composerEmpty: false })).toBe('send');
  });

  it('returns send when error and composer has text', () => {
    expect(deriveSendMode({ streaming: false, isError: true, composerEmpty: false })).toBe('send');
  });

  // --- stop mode ---
  it('returns stop when streaming and composer is empty', () => {
    expect(deriveSendMode({ streaming: true, isError: false, composerEmpty: true })).toBe('stop');
  });

  // --- retry mode ---
  it('returns retry when error and composer is empty', () => {
    expect(deriveSendMode({ streaming: false, isError: true, composerEmpty: true })).toBe('retry');
  });

  // streaming takes precedence over error (defensive — shouldn't happen in practice)
  it('returns stop (not retry) when both streaming and error flags are set with empty composer', () => {
    expect(deriveSendMode({ streaming: true, isError: true, composerEmpty: true })).toBe('stop');
  });
});
