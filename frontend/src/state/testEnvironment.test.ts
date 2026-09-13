import { describe, expect, it } from 'vitest';

describe('logic test environment', () => {
  it('does not load jsdom or browser polyfills', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof ResizeObserver).toBe('undefined');
  });
});
