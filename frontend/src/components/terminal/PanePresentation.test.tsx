import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanePresentationProvider, usePresentedPaneFocus } from './PanePresentation';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { afterPaneMotion } from './paneReveal';

let logicalFocus: string | null = 'a';
let settleFocus: () => void;
vi.mock('../../state/chatStore', () => ({ useChatStore: () => ({ focusedPane: logicalFocus }) }));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { focusDim: 40, paneRules: true } }) }));

function Contents({ settleOnCommit = false }: { settleOnCommit?: boolean }) {
  const visual = usePresentedPaneFocus(logicalFocus);
  settleFocus = visual.settleFocus;
  React.useLayoutEffect(() => {
    if (settleOnCommit) return afterPaneMotion(null, visual.settleFocus);
  });
  const a = usePaneShellStyle('a');
  const b = usePaneShellStyle('b');
  return <><output data-testid="focus">{visual.focusedPane ?? 'none'}</output>
    <div data-testid="a" style={a} /><div data-testid="b" style={b} /></>;
}

function Scene({ focus = 'a', scope = 'tree', enabled = true, ids = ['a', 'b'], settleOnCommit = false }: {
  focus?: string | null; scope?: string; enabled?: boolean; ids?: string[]; settleOnCommit?: boolean;
}) {
  logicalFocus = focus;
  return <React.StrictMode><PanePresentationProvider focusedPane={focus} scope={scope} enabled={enabled} ids={ids} items={{}}>
    <Contents settleOnCommit={settleOnCommit} />
  </PanePresentationProvider></React.StrictMode>;
}

beforeEach(() => { logicalFocus = 'a'; });
afterEach(cleanup);

describe('pane visual focus', () => {
  it('settles synchronously from layout effects without scheduling a commit loop', () => {
    const { rerender, getByTestId } = render(<Scene settleOnCommit />);
    rerender(<Scene focus="b" ids={['b']} settleOnCommit />);
    expect(getByTestId('focus').textContent).toBe('b');
    rerender(<Scene focus="a" ids={['a']} settleOnCommit />);
    expect(getByTestId('focus').textContent).toBe('a');
    rerender(<Scene focus={null} ids={[]} settleOnCommit />);
    expect(getByTestId('focus').textContent).toBe('none');
  });

  it('rejects stale finishes even when rapidly returning to the same target', () => {
    const { rerender, getByTestId } = render(<Scene />);
    rerender(<Scene focus="b" />);
    const stale = settleFocus;
    rerender(<Scene focus="a" />);
    rerender(<Scene focus="b" />);
    act(() => stale());
    expect(getByTestId('focus').textContent).toBe('a');
    act(() => settleFocus());
    expect(getByTestId('focus').textContent).toBe('b');
  });
});
