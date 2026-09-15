import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../../../../state/prefs';
import { ModelPane } from './ModelPane';

const setPref = vi.fn();
const refreshAgentStatus = vi.fn();

vi.mock('../../../../state/chatStore', () => ({
  useChatStore: () => ({ agentStatus: null, refreshAgentStatus }),
}));

vi.mock('../../../../state/prefs', async () => {
  const actual = await vi.importActual<typeof import('../../../../state/prefs')>('../../../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({ prefs: actual.DEFAULT_PREFS, setPref }),
  };
});

describe('ModelPane Kiro sidecar title setting', () => {
  beforeEach(() => {
    setPref.mockClear();
    refreshAgentStatus.mockClear();
  });

  it('renders disabled by default and enables the preference from Settings', () => {
    render(<ModelPane activeProjectId={null} />);

    const toggle = screen.getByRole('switch', { name: 'Generate Kiro titles in background' });
    expect(toggle.getAttribute('aria-checked')).toBe(String(DEFAULT_PREFS.enableKiroSidecarTitles));

    fireEvent.click(toggle);
    expect(setPref).toHaveBeenCalledExactlyOnceWith('enableKiroSidecarTitles', true);
  });
});
