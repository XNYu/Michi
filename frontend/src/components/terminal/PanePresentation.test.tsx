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

function Contents() {
  const visual = usePresentedPaneFocus(logicalFocus);
  settleFocus = visual.settleFocus;
  const a = usePaneShellStyle('a');
  const b = usePaneShellStyle('b');
  return <><output data-testid="focus">{visual.focusedPane ?? 'none'}</output>
    <div data-testid="a" style={a} /><div data-testid="b" style={b} /></>;
}

function Scene({ focus = 'a', scope = 'tree', enabled = true, ids = ['a', 'b'] }: {
  focus?: string | null; scope?: string; enabled?: boolean; ids?: string[];
}) {
  logicalFocus = focus;
  return <PanePresentationProvider focusedPane={focus} scope={scope} enabled={enabled} ids={ids} items={{}}>
    <Contents />
  </PanePresentationProvider>;
}

beforeEach(() => { logicalFocus = 'a'; });
afterEach(cleanup);

describe('pane visual focus', () => {
  it('keeps the destination dim until motion lands, without delaying logical focus', async () => {
    const { rerender, getByTestId } = render(<Scene />);
    const dim = getByTestId('b').style.filter;
    expect(dim).not.toBe('none');
    rerender(<Scene focus="b" />);
    expect(logicalFocus).toBe('b');
    expect(getByTestId('focus').textContent).toBe('a');
    expect(getByTestId('a').style.filter).toBe('none');
    expect(getByTestId('b').style.filter).toBe(dim);
    const animation = new EventTarget() as Animation;
    afterPaneMotion(animation, settleFocus);
    await act(async () => { animation.dispatchEvent(new Event('finish')); });
    expect(getByTestId('focus').textContent).toBe('b');
    expect(getByTestId('b').style.filter).toBe('none');
    expect(getByTestId('a').style.filter).toBe(dim);
  });

  it('does not brighten the survivor when closing or unmounting the old focus', () => {
    const { rerender, getByTestId } = render(<Scene />);
    const dim = getByTestId('b').style.filter;
    rerender(<Scene focus="b" ids={['b']} />);
    expect(getByTestId('b').style.filter).toBe(dim);
    expect(getByTestId('a').style.filter).toBe('none');
    // Presence removal is not visual arrival; expansion still has to finish.
    rerender(<Scene focus="b" ids={['b']} />);
    expect(getByTestId('b').style.filter).toBe(dim);
    act(() => settleFocus());
    expect(getByTestId('b').style.filter).toBe('none');
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

  it('resets across scopes, navigation and an empty workspace', () => {
    const { rerender, getByTestId } = render(<Scene />);
    rerender(<Scene focus="b" scope="other-tree" />);
    expect(getByTestId('focus').textContent).toBe('b');
    rerender(<Scene focus="a" scope="other-tree" enabled={false} />);
    expect(getByTestId('focus').textContent).toBe('a');
    rerender(<Scene focus="b" scope="other-tree" />);
    expect(getByTestId('focus').textContent).toBe('b');
    rerender(<Scene focus={null} scope="other-tree" ids={[]} />);
    expect(getByTestId('focus').textContent).toBe('none');
  });
});
