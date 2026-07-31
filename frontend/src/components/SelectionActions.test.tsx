import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SelectionActions, { placePopup, findMessageIdForRange } from './SelectionActions';

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

  it('keeps the source text visually highlighted while the branch composer is open', () => {
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

    const textNode = screen.getByText('selected source text').firstChild;
    expect(textNode).toBeTruthy();

    act(() => {
      const range = document.createRange();
      range.setStart(textNode as Node, 0);
      range.setEnd(textNode as Node, 'selected source text'.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    // Advance past the 80ms content-stability debounce
    act(() => { vi.advanceTimersByTime(80); });

    const branchButton = screen.getByRole('button', { name: /Branch/i });
    fireEvent.mouseDown(branchButton);
    fireEvent.click(branchButton);

    expect(screen.getByText('BRANCH FROM SELECTION')).toBeTruthy();
    const highlightLayer = document.body.querySelector('[aria-hidden="true"]');
    expect(highlightLayer).toBeTruthy();
    expect(highlightLayer?.children).toHaveLength(2);
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

    expect(onComment).toHaveBeenCalledWith('selected source text', 'my reply body');
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

  it('closes the comment composer when the footer Cancel button is clicked', () => {
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

    const cancelBtn = screen.getByRole('button', { name: /^Cancel/ });
    fireEvent.mouseDown(cancelBtn);
    fireEvent.click(cancelBtn);

    expect(screen.queryByText('COMMENT ON SELECTION')).toBeNull();
    expect(onComment).not.toHaveBeenCalled();
  });

  it('fires onComment when the footer Save button is clicked in comment mode', () => {
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

    const textarea = screen.getByPlaceholderText(/your reply/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'my reply body' } });

    const saveBtn = screen.getByRole('button', { name: /^Save/ });
    fireEvent.mouseDown(saveBtn);
    fireEvent.click(saveBtn);

    expect(onComment).toHaveBeenCalledWith('selected source text', 'my reply body');
    expect(screen.queryByText('COMMENT ON SELECTION')).toBeNull();
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

    expect(onBranch).toHaveBeenCalledWith('selected source text', 'why does this work?', undefined);
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

  it('debounces the bar appearance until selection content stabilizes (80ms)', () => {
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

    // Simulate double-click: first selectionchange with partial text
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 5); // "hello"
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    // Bar should NOT be visible yet
    expect(screen.queryByRole('button', { name: /Branch/i })).toBeNull();

    // 40ms later, selection expands (simulating triple-click intermediate)
    act(() => { vi.advanceTimersByTime(40); });
    act(() => {
      const range = document.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 11); // "hello world"
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });

    // Still not visible — timer reset by new content
    expect(screen.queryByRole('button', { name: /Branch/i })).toBeNull();

    // Advance 79ms — still not enough
    act(() => { vi.advanceTimersByTime(79); });
    expect(screen.queryByRole('button', { name: /Branch/i })).toBeNull();

    // 1 more ms → 80ms since last content change → bar appears
    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.getByRole('button', { name: /Branch/i })).toBeTruthy();
  });

  it('disables the footer Save button when the composer prompt is empty', () => {
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

    const saveBtn = screen.getByRole('button', { name: /^Save/ }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    fireEvent.mouseDown(saveBtn);
    fireEvent.click(saveBtn);

    expect(onComment).not.toHaveBeenCalled();
  });
});

describe('findMessageIdForRange', () => {
  it('returns nearest ancestor data-msg-id', () => {
    const wrapper = document.createElement('div');
    wrapper.dataset.msgId = 'm-abc';
    const p = document.createElement('p');
    const text = document.createTextNode('hello');
    p.appendChild(text);
    wrapper.appendChild(p);
    document.body.appendChild(wrapper);

    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);
    expect(findMessageIdForRange(range)).toBe('m-abc');

    document.body.removeChild(wrapper);
  });

  it('returns undefined when no ancestor has data-msg-id', () => {
    const div = document.createElement('div');
    const text = document.createTextNode('orphan');
    div.appendChild(text);
    document.body.appendChild(div);

    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 6);
    expect(findMessageIdForRange(range)).toBeUndefined();

    document.body.removeChild(div);
  });

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

describe('placePopup', () => {
  const POPUP_W = 280;
  const POPUP_H = 34;
  const originalWindow = { w: window.innerWidth, h: window.innerHeight };

  function setViewport(w: number, h: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  }

  afterEach(() => setViewport(originalWindow.w, originalWindow.h));

  it('prefers above the selection when there is room', () => {
    setViewport(1024, 800);
    const sel = rect(200, 400, 200, 24);
    const placement = placePopup(sel, [sel], /* composerTop */ 700, POPUP_W, POPUP_H);
    // top = sel.top - GAP - height = 400 - 16 - 34 = 350
    expect(placement.top).toBe(350);
  });

  it('falls through to below when above is off-screen but below clears the composer', () => {
    setViewport(1024, 800);
    // Selection starts near viewport top — no room above.
    const sel = rect(200, 4, 200, 24);
    const placement = placePopup(sel, [sel], /* composerTop */ 700, POPUP_W, POPUP_H);
    // top = sel.bottom + GAP = 28 + 16 = 44
    expect(placement.top).toBe(44);
  });

  it('falls back to above (even cramped) when below would overlap the composer', () => {
    setViewport(1024, 800);
    // Long selection: first visible line near top, last visible line just
    // above the composer — neither above nor below fits.
    const firstVisible = rect(80, 6, 800, 18);
    const lastVisible = rect(80, 660, 800, 18);
    const bounds = rect(80, 6, 800, 672);
    const composerTop = 690;
    const placement = placePopup(
      bounds,
      [firstVisible, lastVisible],
      composerTop,
      POPUP_W,
      POPUP_H,
    );
    // Computed: firstVisible.top - GAP - H = 6 - 16 - 34 = -44 → clamps to
    // VIEWPORT_MARGIN (8). The popup sits above the selection's visible top,
    // not crammed into the composer area.
    expect(placement.top).toBe(8);
  });

  it('anchors horizontally on the union of all highlight rects', () => {
    setViewport(1024, 800);
    // Multi-line selection that wraps: first visible line is short and on
    // the right, second line is on the left. The popup should center on the
    // union bounding box of both lines.
    const firstVisible = rect(600, 400, 200, 18);
    const bounds = rect(80, 400, 800, 60);
    const placement = placePopup(
      bounds,
      [firstVisible, rect(80, 442, 600, 18)],
      /* composerTop */ 700,
      POPUP_W,
      POPUP_H,
    );
    // Union: left=80, right=800 → center=440. left = 440 - 140 = 300.
    expect(placement.left).toBe(300);
  });
});
