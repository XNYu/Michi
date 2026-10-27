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
});
