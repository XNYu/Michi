import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaneShellStyle } from './usePaneShellStyle';

// --- Mocks ---

const mockPrefs = { paneRules: true, focusDim: 40 };
vi.mock('../state/prefs', () => ({
  usePrefs: () => ({ prefs: mockPrefs }),
}));

let mockFocusedPane: string | null = null;
vi.mock('../state/chatStore', () => ({
  useChatStore: () => ({ focusedPane: mockFocusedPane }),
}));

describe('usePaneShellStyle', () => {
  beforeEach(() => {
    mockFocusedPane = null;
    mockPrefs.paneRules = true;
    mockPrefs.focusDim = 40;
  });

  it('returns base flex column layout', () => {
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    expect(result.current.display).toBe('flex');
    expect(result.current.flexDirection).toBe('column');
    expect(result.current.height).toBe('100%');
    expect(result.current.position).toBe('relative');
  });

  it('shows borderRight when paneRules is true', () => {
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    expect(result.current.borderRight).toBe('var(--term-pane-divider, 1px solid var(--term-line))');
  });

  it('hides borderRight when paneRules is false', () => {
    mockPrefs.paneRules = false;
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    expect(result.current.borderRight).toBe('none');
  });

  it('is fully opaque when no pane is focused (focusedPane=null)', () => {
    mockFocusedPane = null;
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    expect(result.current.opacity).toBeUndefined();
    expect(result.current.filter).toBe('none');
  });

  it('is fully opaque when this pane is the focused one', () => {
    mockFocusedPane = 'node-1';
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    expect(result.current.opacity).toBeUndefined();
    expect(result.current.filter).toBe('none');
  });

  it('dims with brightness only when another pane is focused', () => {
    mockFocusedPane = 'other-node';
    mockPrefs.focusDim = 40;
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    // No opacity dim: the Topbar caption cell dims with brightness() only, and
    // stacking opacity here made the pane body darker than its title strip.
    expect(result.current.opacity).toBeUndefined();
    // brightness = 1 - 40/100 * 0.6 = 0.76 (same formula as Topbar.tsx)
    expect(result.current.filter).toBe('brightness(0.76)');
    expect(result.current.transition).not.toContain('opacity');
  });

  it('does not dim when focusDim is 0', () => {
    mockFocusedPane = 'other-node';
    mockPrefs.focusDim = 0;
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    expect(result.current.opacity).toBeUndefined();
    expect(result.current.filter).toBe('brightness(1)');
  });

  it('returns stable reference when inputs do not change', () => {
    const { result, rerender } = renderHook(() => usePaneShellStyle('node-1'));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first); // same object reference
  });

  it('includes theme CSS variables for customization', () => {
    const { result } = renderHook(() => usePaneShellStyle('node-1'));
    expect(result.current.background).toContain('--term-pane-bg');
    expect(result.current.borderRadius).toContain('--term-pane-radius');
    expect(result.current.boxShadow).toContain('--term-pane-shadow');
  });
});
