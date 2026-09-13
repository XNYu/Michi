import { describe, expect, it } from 'vitest';

describe('DOM test environment', () => {
  it('keeps browser APIs available outside the audited logic directories', () => {
    expect(document.createElement('div')).toBeInstanceOf(HTMLElement);
    expect(typeof ResizeObserver).toBe('function');
    expect(typeof Range.prototype.getBoundingClientRect).toBe('function');
    localStorage.setItem('test-environment', 'value');
    expect(window.localStorage.getItem('test-environment')).toBe('value');
    localStorage.clear();
    expect(localStorage.length).toBe(0);
  });

  it('fails immediately on a React effect loop instead of starving the test timeout', () => {
    expect(() => console.error('Warning: Maximum update depth exceeded.')).toThrow(
      /Maximum update depth exceeded: check for unstable test props/,
    );
  });
});
