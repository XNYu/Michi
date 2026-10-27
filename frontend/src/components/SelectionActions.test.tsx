import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SelectionActions, { stickyPlacement, findMessageIdForRange, type SelectionActionsProps } from './SelectionActions';

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

    expect(screen.getByText('COMMENT ON SELECTION')).toBeTruthy();

    const textarea = screen.getByPlaceholderText(/your reply/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my reply body' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onComment).toHaveBeenCalledWith('selected source text', 'my reply body', expect.anything());
    expect(onBranch).not.toHaveBeenCalled();
    expect(onQuote).not.toHaveBeenCalled();
    // Bar closes after submit.
    expect(screen.queryByText('COMMENT ON SELECTION')).toBeNull();
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

    expect(screen.getByText('COMMENT ON SELECTION')).toBeTruthy();
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
    expect(screen.queryByText('BRANCH FROM SELECTION')).toBeNull();
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
    // Union 300..460 → centre 380 → left 240; firstVisible.top 200 → top 150.
    // Away from every viewport clamp, so the assertions below are meaningful.
    expect(settled.left).toBe('240px');
    expect(settled.top).toBe('150px');

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
    expect(bar.style.top).toBe('150px');

    // Scroll by 3px — under the dead-zone, but the bar is glued to the text.
    lineRects = [rect(300, 197, 120, 18), rect(300, 219, 160, 18)];
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      vi.advanceTimersByTime(20);
    });

    expect(bar.style.top).toBe('147px');
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
