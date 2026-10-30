import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { DOCK_ROOM_VAR } from './selectionDockRoom';
import SelectionActions, { dockClearance, placeDock, placeTouchPopup, stickyPlacement, findMessageIdForRange, type SelectionActionsProps } from './SelectionActions';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('SelectionActions', () => {
  const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
  const originalGetClientRects = Range.prototype.getClientRects;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: vi.fn(() => rect(40, 50, 160, 40)),
    });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(() => [
        rect(40, 50, 120, 18),
        rect(40, 72, 160, 18),
      ] as unknown as DOMRectList),
    });
  });

  afterEach(() => {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: originalGetBoundingClientRect,
    });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: originalGetClientRects,
    });
    window.getSelection()?.removeAllRanges();
    pointerDown('mouse');
    vi.useRealTimers();
  });

  function ContextHarness(props: Omit<SelectionActionsProps, 'containerRef'>) {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      if (ref.current) ref.current.getBoundingClientRect = () => rect(0, 0, 400, 300);
    }, []);
    return <div ref={ref}><span>immutable source text</span><SelectionActions {...props} containerRef={ref} /></div>;
  }

  function selectContextSource() {
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(screen.getByText('immutable source text'));
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(80);
    });
  }

  it('shows the captured passage only while composing, without a details control', () => {
    const onComment = vi.fn();
    render(<ContextHarness onQuote={vi.fn()} onBranch={vi.fn()} onComment={onComment}
      captureSelectionContext={() => ({ source: 'original.md' })}
      getSelectionSourceLabel={context => (context as { source: string }).source}
      renderSelectionContext={() => <span>Send to original thread</span>} />);
    selectContextSource();
    expect(screen.queryByLabelText('Selected passage')).toBeNull();
    expect(document.querySelector('details')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(screen.getByLabelText('Selected passage').textContent).toContain('immutable source text');
    expect(screen.getByLabelText('Selected passage').textContent).toContain('original.md');
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'Comment on the original passage' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onComment).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    expect(onComment).toHaveBeenCalledWith('immutable source text', 'Comment on the original passage', expect.any(Range), { source: 'original.md' });
  });

  it('captures context once and submits it to the latest callback after props and focus change', () => {
    const token = { snapshot: 'v1', target: 'thread A' };
    const capture = vi.fn(() => token);
    const initialComment = vi.fn();
    const currentComment = vi.fn();
    const props = { onQuote: vi.fn(), onBranch: vi.fn(), onComment: initialComment, captureSelectionContext: capture };
    const { rerender } = render(<ContextHarness {...props} />);
    selectContextSource();
    const newerCapture = vi.fn(() => ({ snapshot: 'v2', target: 'thread B' }));
    rerender(<ContextHarness {...props} onComment={currentComment} captureSelectionContext={newerCapture} />);
    act(() => document.dispatchEvent(new Event('selectionchange')));
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'keep this reply' } });
    rerender(<ContextHarness {...props} onComment={currentComment} captureSelectionContext={newerCapture} />);
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(newerCapture).not.toHaveBeenCalled();
    expect(currentComment).toHaveBeenCalledWith('immutable source text', 'keep this reply', expect.any(Range), token);
    expect(initialComment).not.toHaveBeenCalled();
  });

  it.each(['comment', 'branch'] as const)('keeps the %s draft and captured context after rejected submission, then permits explicit replacement', (mode) => {
    const token = { target: 'thread A' };
    const replacement = { target: 'thread C' };
    const callback = vi.fn((..._args: unknown[]) => false);
    const renderContext: SelectionActionsProps['renderSelectionContext'] = (context, replace) => (
      <button onClick={() => replace(replacement)}>Target: {(context as typeof token).target}</button>
    );
    render(<ContextHarness onQuote={vi.fn()} onComment={callback} onBranch={callback}
      captureSelectionContext={() => token} renderSelectionContext={renderContext} />);
    selectContextSource();
    fireEvent.click(screen.getByRole('button', { name: mode === 'comment' ? 'Comment' : 'Branch' }));
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'preserve my draft' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(textarea.value).toBe('preserve my draft');
    expect(callback.mock.calls[0].at(-1)).toBe(token);
    fireEvent.click(screen.getByRole('button', { name: 'Target: thread A' }));
    expect(screen.getByRole('button', { name: 'Target: thread C' })).toBeTruthy();
    expect(textarea.value).toBe('preserve my draft');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(callback.mock.calls[1].at(-1)).toBe(replacement);
  });

  it('retains quote actions after rejection and carries the captured context on retry', () => {
    const token = { target: 'thread A' };
    const onQuote = vi.fn().mockReturnValueOnce(false);
    render(<ContextHarness onQuote={onQuote} onBranch={vi.fn()} onComment={vi.fn()} captureSelectionContext={() => token} />);
    selectContextSource();
    fireEvent.click(screen.getByRole('button', { name: 'Quote' }));
    expect(screen.getByRole('button', { name: 'Quote' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Quote' }));
    expect(onQuote).toHaveBeenLastCalledWith('immutable source text', expect.any(Range), token);
    expect(screen.queryByRole('button', { name: 'Quote' })).toBeNull();
  });

  it.each(['comment', 'branch'] as const)('restores an opted-in %s draft and its captured context after outside click and remount', (mode) => {
    const key = `restore-${mode}`;
    const token = { snapshot: { text: 'version one' }, target: 'original thread' };
    const callback = vi.fn();
    const props = { onQuote: vi.fn(), onBranch: callback, onComment: callback,
      captureSelectionContext: vi.fn(() => token), selectionDraftKey: key };
    const first = render(<ContextHarness {...props} />);
    selectContextSource();
    fireEvent.click(screen.getByRole('button', { name: mode === 'comment' ? 'Comment' : 'Branch' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'draft before navigation' } });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: `Resume selection ${mode}` })).toBeTruthy();
    // While hidden, selecting another passage must not overwrite the saved draft.
    selectContextSource();
    expect(screen.getByRole('button', { name: `Resume selection ${mode}` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Resume selection ${mode}` }));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('draft before navigation');
    const saved = JSON.parse(sessionStorage.getItem('michi:selection-drafts:v1')!);
    expect(JSON.parse(saved.find(([savedKey]: [string, string]) => savedKey === key)[1])).toMatchObject({
      text: 'immutable source text', prompt: 'draft before navigation', context: token, mode,
    });
    first.unmount();
    const newerCapture = vi.fn(() => ({ snapshot: 'v2', target: 'new thread' }));
    render(<ContextHarness {...props} captureSelectionContext={newerCapture} />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.value).toBe('draft before navigation');
    expect(newerCapture).not.toHaveBeenCalled();
    expect(document.querySelector('.sel-actions-term-highlight-layer')).toBeNull();
    fireEvent.keyDown(textarea, { key: 'Enter' });
    if (mode === 'comment') {
      expect(callback).toHaveBeenCalledWith('immutable source text', 'draft before navigation', undefined, token);
    } else {
      expect(callback).toHaveBeenCalledWith('immutable source text', 'draft before navigation', undefined, undefined, token);
    }
    expect(sessionStorage.getItem('michi:selection-drafts:v1')).not.toContain(key);
  });

  it('isolates persisted drafts by resource key and clears a restored draft on explicit cancel', () => {
    const props = { onQuote: vi.fn(), onBranch: vi.fn(), onComment: vi.fn(), captureSelectionContext: () => ({ target: 'A' }) };
    const initial = render(<ContextHarness {...props} selectionDraftKey="backend-A/file-one" />);
    selectContextSource();
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private draft A' } });
    initial.unmount();
    const other = render(<ContextHarness {...props} selectionDraftKey="backend-B/file-one" />);
    expect(screen.queryByRole('textbox')).toBeNull();
    other.unmount();
    const restored = render(<ContextHarness {...props} selectionDraftKey="backend-A/file-one" />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('private draft A');
    fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
    restored.unmount();
    render(<ContextHarness {...props} selectionDraftKey="backend-A/file-one" />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('opens a comment composer when the Comment button is clicked and fires onComment on Enter', () => {
    const onBranch = vi.fn();
    const onQuote = vi.fn();
    const onComment = vi.fn();

    function Harness() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (ref.current) {
          ref.current.getBoundingClientRect = () => rect(0, 0, 400, 300);
        }
      }, []);
      return (
        <div ref={ref}>
          selected source text
          <SelectionActions
            containerRef={ref}
            onBranch={onBranch}
            onQuote={onQuote}
            onComment={onComment}
          />
        </div>
      );
    }

    render(<Harness />);

    const textNode = screen.getByText('selected source text').firstChild!;
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 'selected source text'.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    // Advance past the 80ms content-stability debounce
    act(() => { vi.advanceTimersByTime(80); });

    const commentButton = screen.getByRole('button', { name: /Comment/i });
    fireEvent.mouseDown(commentButton);
    fireEvent.click(commentButton);

    expect(screen.getByText('Comment')).toBeTruthy();

    const textarea = screen.getByPlaceholderText(/your reply/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my reply body' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onComment).toHaveBeenCalledWith('selected source text', 'my reply body', expect.anything());
    expect(onBranch).not.toHaveBeenCalled();
    expect(onQuote).not.toHaveBeenCalled();
    // Bar closes after submit.
    expect(screen.queryByText('Comment')).toBeNull();
  });

  it('opens the comment composer via ⌘; global hotkey', () => {
    const onBranch = vi.fn();
    const onQuote = vi.fn();
    const onComment = vi.fn();

    function Harness() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (ref.current) {
          ref.current.getBoundingClientRect = () => rect(0, 0, 400, 300);
        }
      }, []);
      return (
        <div ref={ref}>
          hotkey target
          <SelectionActions
            containerRef={ref}
            onBranch={onBranch}
            onQuote={onQuote}
            onComment={onComment}
          />
        </div>
      );
    }

    render(<Harness />);

    const textNode = screen.getByText('hotkey target').firstChild!;
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 'hotkey target'.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    // Advance past the 80ms content-stability debounce
    act(() => { vi.advanceTimersByTime(80); });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ';', metaKey: true }));
    });

    expect(screen.getByText('Comment')).toBeTruthy();
  });

  it('fires onBranch when the footer Branch button is clicked in branch mode', () => {
    const onBranch = vi.fn();
    const onQuote = vi.fn();
    const onComment = vi.fn();

    function Harness() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (ref.current) {
          ref.current.getBoundingClientRect = () => rect(0, 0, 400, 300);
        }
      }, []);
      return (
        <div ref={ref}>
          selected source text
          <SelectionActions
            containerRef={ref}
            onBranch={onBranch}
            onQuote={onQuote}
            onComment={onComment}
          />
        </div>
      );
    }

    render(<Harness />);

    const textNode = screen.getByText('selected source text').firstChild!;
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 'selected source text'.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    // Advance past the 80ms content-stability debounce
    act(() => { vi.advanceTimersByTime(80); });

    const branchOpenButton = screen.getByRole('button', { name: /Branch/i });
    fireEvent.mouseDown(branchOpenButton);
    fireEvent.click(branchOpenButton);

    const textarea = screen.getByPlaceholderText(/ask something/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'why does this work?' } });

    const branchSubmitBtn = screen.getByRole('button', { name: /^Branch/ });
    fireEvent.mouseDown(branchSubmitBtn);
    fireEvent.click(branchSubmitBtn);

    expect(onBranch).toHaveBeenCalledWith('selected source text', 'why does this work?', undefined, expect.anything());
    expect(screen.queryByText('Branch from selection')).toBeNull();
  });

  it('does not re-measure the popup on scroll-driven anchor updates (no per-frame forced layout)', () => {
    // Regression: the popup-size useLayoutEffect used to run with no dep array,
    // so every scroll — which updates the anchor's bounds via a fresh object
    // reference each frame — re-ran getBoundingClientRect on the popup in the
    // commit (layout) phase. With a selection present, scrolling a chat pane
    // therefore forced a synchronous reflow every frame and dropped scrolling
    // off the compositor thread. The popup's *size* only changes with mode /
    // selected text / draft, so scroll must not trigger a remeasure.
    const onBranch = vi.fn();
    const onQuote = vi.fn();
    const onComment = vi.fn();

    let popupMeasures = 0;

    function Harness() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (ref.current) {
          ref.current.getBoundingClientRect = () => rect(0, 0, 400, 300);
        }
      }, []);
      return (
        <div ref={ref}>
          selected source text
          <SelectionActions
            containerRef={ref}
            onBranch={onBranch}
            onQuote={onQuote}
            onComment={onComment}
          />
        </div>
      );
    }

    render(<Harness />);

    const textNode = screen.getByText('selected source text').firstChild!;
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 'selected source text'.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    // Advance past the 80ms content-stability debounce
    act(() => { vi.advanceTimersByTime(80); });

    // The bar is now rendered. Instrument the popup's getBoundingClientRect so
    // we can count remeasures triggered purely by scroll.
    const bar = document.body.querySelector('.sel-actions-enter') as HTMLElement;
    expect(bar).toBeTruthy();
    bar.getBoundingClientRect = () => {
      popupMeasures += 1;
      return rect(40, 10, 280, 34);
    };

    // Scroll several times. Each scroll recomputes the anchor (new object), but
    // the popup size hasn't changed, so it must not be remeasured.
    act(() => {
      for (let i = 0; i < 5; i++) {
        window.dispatchEvent(new Event('scroll'));
      }
    });

    expect(popupMeasures).toBe(0);
  });

  it('holds the bar position when a selection edit barely moves it, and follows a real move', () => {
    const onBranch = vi.fn();
    const onQuote = vi.fn();
    const onComment = vi.fn();

    let lineRects = [rect(300, 200, 120, 18), rect(300, 222, 160, 18)];
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(() => lineRects as unknown as DOMRectList),
    });

    function Harness() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (ref.current) {
          ref.current.getBoundingClientRect = () => rect(0, 0, 1000, 600);
        }
      }, []);
      return (
        <div ref={ref}>
          hello world foobar
          <SelectionActions
            containerRef={ref}
            onBranch={onBranch}
            onQuote={onQuote}
            onComment={onComment}
          />
        </div>
      );
    }

    render(<Harness />);
    const textNode = screen.getByText('hello world foobar').firstChild!;

    const select = (end: number) => {
      act(() => {
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, end);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
      });
    };

    select(5);
    act(() => { vi.advanceTimersByTime(80); });

    const bar = document.body.querySelector('.sel-actions-enter') as HTMLElement;
    expect(bar).toBeTruthy();
    const settled = { left: bar.style.left, top: bar.style.top };
    // Union 300..460 → centre 380 → left 240; firstVisible.top 200 − 16px gap − 36px bar → top 148.
    // Away from every viewport clamp, so the assertions below are meaningful.
    expect(settled.left).toBe('240px');
    expect(settled.top).toBe('148px');

    // Extending the selection by a short word nudges the union edges a few px
    // (and sub-pixel rect noise nudges the top). The bar must not budge.
    lineRects = [rect(301.4, 201.2, 124, 18), rect(300, 223.1, 165, 18)];
    select(11);
    expect(bar.style.left).toBe(settled.left);
    expect(bar.style.top).toBe(settled.top);

    // A real extension — union centre jumps 90px — moves it.
    lineRects = [rect(300, 200, 300, 18), rect(300, 222, 340, 18)];
    select(18);
    expect(bar.style.left).toBe('330px');
  });

  it('follows scroll 1:1 even when the shift is inside the dead-zone', () => {
    // Regression guard: the selection-edit dead-zone must not apply to
    // scroll-driven repositioning, or the bar visibly lags a slow scroll and
    // then snaps once the accumulated delta crosses the threshold.
    const onBranch = vi.fn();
    const onQuote = vi.fn();
    const onComment = vi.fn();

    let lineRects = [rect(300, 200, 120, 18), rect(300, 222, 160, 18)];
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(() => lineRects as unknown as DOMRectList),
    });

    function Harness() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (ref.current) {
          ref.current.getBoundingClientRect = () => rect(0, 0, 1000, 600);
        }
      }, []);
      return (
        <div ref={ref}>
          hello world foobar
          <SelectionActions
            containerRef={ref}
            onBranch={onBranch}
            onQuote={onQuote}
            onComment={onComment}
          />
        </div>
      );
    }

    render(<Harness />);
    const textNode = screen.getByText('hello world foobar').firstChild!;
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    act(() => { vi.advanceTimersByTime(80); });

    const bar = document.body.querySelector('.sel-actions-enter') as HTMLElement;
    expect(bar.style.top).toBe('148px');

    // Scroll by 3px — under the dead-zone, but the bar is glued to the text.
    lineRects = [rect(300, 197, 120, 18), rect(300, 219, 160, 18)];
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);
    });

    expect(bar.style.top).toBe('145px');
  });

  it('docks the bar of a touch selection to the pane edge, clear of the platform edit menu', () => {
    let lineRects = [rect(300, 200, 120, 18), rect(300, 222, 160, 18)];
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(() => lineRects as unknown as DOMRectList),
    });

    function Harness() {
      const ref = React.useRef<HTMLDivElement>(null);
      React.useEffect(() => {
        if (ref.current) ref.current.getBoundingClientRect = () => rect(0, 0, 1000, 600);
      }, []);
      return (
        <div ref={ref}>
          hello world foobar
          <SelectionActions containerRef={ref} onBranch={vi.fn()} onQuote={vi.fn()} onComment={vi.fn()} />
        </div>
      );
    }

    render(<Harness />);
    const textNode = screen.getByText('hello world foobar').firstChild!;
    const select = (end: number, pointerType: string) => {
      act(() => {
        pointerDown(pointerType);
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, end);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event('selectionchange'));
        vi.advanceTimersByTime(80);
      });
    };
    const bar = () => document.body.querySelector('.sel-actions-enter') as HTMLElement;

    // Pane 0..1000 × 0..600, fallback bar 280 × 36, selection 300..460 ×
    // 200..240. The platform menu may open on either side, even with room
    // above, so the bar goes below, beyond the menu's lower slot: 240 + 64.
    select(5, 'touch');
    expect(bar().style.left).toBe('240px');
    expect(bar().style.top).toBe('304px');

    // Near the composer there is no room below: above the selection, beyond
    // the platform menu's slot: 500 − 64 − 36.
    lineRects = [rect(300, 500, 120, 18), rect(300, 522, 160, 18)];
    select(11, 'touch');
    expect(bar().style.top).toBe('400px');

    // Near the top the same rule holds: 70 + 64.
    lineRects = [rect(300, 30, 120, 18), rect(300, 52, 160, 18)];
    select(5, 'touch');
    expect(bar().style.top).toBe('134px');

    // A mouse selection floats above it as before.
    lineRects = [rect(300, 500, 120, 18), rect(300, 522, 160, 18)];
    act(() => { window.getSelection()?.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')); });
    expect(bar()).toBeNull();
    select(11, 'mouse');
    expect(bar().style.top).toBe('448px');
  });
});

describe('SelectionActions on a phone', () => {
  const originalWidth = window.innerWidth;
  const originalGetBoundingClientRect = Range.prototype.getBoundingClientRect;
  const originalGetClientRects = Range.prototype.getClientRects;
  let line = rect(50, 200, 290, 20);
  beforeEach(() => {
    vi.useFakeTimers();
    line = rect(50, 200, 290, 20);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: vi.fn(() => [line] as unknown as DOMRectList),
    });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: vi.fn(() => line),
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: originalGetBoundingClientRect });
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: originalGetClientRects });
    window.getSelection()?.removeAllRanges();
    vi.useRealTimers();
  });

  function Harness({ onBranch = vi.fn(), scrollBy }: { onBranch?: () => void; scrollBy?: (options: ScrollToOptions) => void }) {
    const ref = React.useRef<HTMLDivElement>(null);
    const composerRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
      if (ref.current) ref.current.getBoundingClientRect = () => rect(0, 90, 390, 600);
      if (ref.current && scrollBy) {
        // Scrolled to the end: 400 + 600 = 1000.
        Object.defineProperty(ref.current, 'scrollHeight', { configurable: true, value: 1000 });
        Object.defineProperty(ref.current, 'clientHeight', { configurable: true, value: 600 });
        ref.current.scrollTop = 400;
        ref.current.scrollBy = scrollBy as HTMLElement['scrollBy'];
      }
      if (composerRef.current) composerRef.current.getBoundingClientRect = () => rect(12, 712, 366, 50);
    }, [scrollBy]);
    return (
      <div>
        <div ref={ref}>
          hello world foobar
          <SelectionActions containerRef={ref} onBranch={onBranch} onQuote={vi.fn()} onComment={vi.fn()} />
        </div>
        <div ref={composerRef} className="terminal-composer">Reply…</div>
      </div>
    );
  }

  const select = (pointerType: string) => {
    const textNode = screen.getByText(/hello world foobar/).firstChild!;
    act(() => {
      pointerDown(pointerType);
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(80);
    });
  };
  const bar = () => document.body.querySelector('.sel-actions-enter') as HTMLElement | null;

  it('docks the bar of a touch selection over the composer', () => {
    render(<Harness />);
    select('touch');
    expect(bar()!.classList.contains('is-dock')).toBe(true);
    expect(bar()!.style.left).toBe('12px');
    expect(bar()!.style.top).toBe('712px');
    expect(bar()!.style.width).toBe('366px');

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(bar()).toBeNull();
    expect(window.getSelection()?.isCollapsed).toBe(true);
  });

  it('opens the Branch sheet from the docked bar', () => {
    render(<Harness />);
    select('touch');
    fireEvent.click(screen.getByRole('button', { name: 'Branch' }));
    expect(bar()!.classList.contains('is-sheet')).toBe(true);
    expect(bar()!.classList.contains('is-dock')).toBe(false);
  });

  it('keeps a mouse selection beside the text', () => {
    render(<Harness />);
    select('mouse');
    expect(bar()!.classList.contains('is-dock')).toBe(false);
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();
  });

  it('scrolls a selection on the last lines up clear of the docked bar, adding room at the end', () => {
    // Last line ends at 690; the platform menu below it needs up to 754,
    // the docked bar starts at 712: 42px.
    line = rect(50, 670, 290, 20);
    const scrollBy = vi.fn();
    const { container } = render(<Harness scrollBy={scrollBy} />);
    const scroller = container.firstElementChild!.firstElementChild as HTMLElement;
    select('touch');
    expect(scrollBy).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(350); });
    expect(scrollBy).toHaveBeenCalledWith({ top: 42, behavior: 'smooth' });
    expect(scroller.style.getPropertyValue(DOCK_ROOM_VAR)).toBe('42px');

    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(scroller.style.getPropertyValue(DOCK_ROOM_VAR)).toBe('');
  });

  it('does not scroll a selection already clear of the docked bar', () => {
    const scrollBy = vi.fn();
    render(<Harness scrollBy={scrollBy} />);
    select('touch');
    act(() => { vi.advanceTimersByTime(350); });
    expect(scrollBy).not.toHaveBeenCalled();
  });
});

describe('dockClearance', () => {
  it('lifts the last line so the platform menu below it ends above the bar', () => {
    expect(dockClearance([rect(50, 670, 290, 20)], 712, 90)).toBe(42);
    expect(dockClearance([rect(50, 600, 290, 20)], 712, 90)).toBe(0);
  });

  it('leaves a selection alone when lifting it would push its first line out of view', () => {
    expect(dockClearance([rect(50, 100, 290, 20), rect(50, 670, 290, 20)], 712, 90)).toBe(0);
  });
});

describe('placeDock', () => {
  it('fills one composer row along its bottom edge', () => {
    expect(placeDock({ left: 12, bottom: 762, width: 366, height: 50 }))
      .toEqual({ left: 12, top: 712, width: 366, height: 50 });
    // A tall composer keeps the top of its draft visible.
    expect(placeDock({ left: 12, bottom: 762, width: 366, height: 140 }).top).toBe(706);
    // A short one still gets a touch-sized bar.
    expect(placeDock({ left: 12, bottom: 762, width: 366, height: 30 }).height).toBe(44);
  });
});

function pointerDown(pointerType: string) {
  const event = new Event('pointerdown', { bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  document.body.dispatchEvent(event);
}

describe('placeTouchPopup', () => {
  // Bar 280 × 40, composer top at 700, so the bar's bottom stays ≤ 692.
  const pane = { left: 0, top: 100, right: 390, bottom: 800, width: 390, height: 700 };
  const line = (top: number) => rect(50, top, 290, 20);

  it('goes below the selection, beyond the platform menu, even with room above for the menu', () => {
    // iOS 26 can open its menu below such a selection (IMG_3705).
    expect(placeTouchPopup(pane, [line(300)], 700, 280, 40))
      .toEqual({ left: 55, top: 384, above: false });
  });

  it('goes above the selection, beyond the platform menu, when there is no room below', () => {
    expect(placeTouchPopup(pane, [line(640)], 700, 280, 40))
      .toEqual({ left: 55, top: 536, above: true });
  });

  it('goes under the platform menu when the selection is near the top', () => {
    const topPane = { ...pane, top: 0 };
    expect(placeTouchPopup(topPane, [line(40)], 700, 280, 40))
      .toEqual({ left: 55, top: 124, above: false });
  });

  it('docks above the composer when the selection fills the pane', () => {
    expect(placeTouchPopup(pane, [line(130), line(640)], 700, 280, 40))
      .toEqual({ left: 55, top: 652, above: false });
  });

  it('stays inside the pane horizontally', () => {
    expect(placeTouchPopup(pane, [rect(300, 300, 80, 20)], 700, 280, 40).left).toBe(102);
  });
});

describe('findMessageIdForRange', () => {
  it('returns innermost data-msg-id when nested', () => {
    const outer = document.createElement('div');
    outer.dataset.msgId = 'outer';
    const inner = document.createElement('div');
    inner.dataset.msgId = 'inner';
    const text = document.createTextNode('x');
    inner.appendChild(text);
    outer.appendChild(inner);
    document.body.appendChild(outer);

    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    expect(findMessageIdForRange(range)).toBe('inner');

    document.body.removeChild(outer);
  });
});

describe('stickyPlacement', () => {
  const at = (left: number, top: number, above = true) => ({ left, top, above });

  it('always honours an above/below flip regardless of distance', () => {
    const prev = at(300, 350, true);
    const flipped = at(302, 351, false);
    expect(stickyPlacement(flipped, prev)).toEqual(flipped);
  });
});
