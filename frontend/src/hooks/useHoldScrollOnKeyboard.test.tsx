import { render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHoldScrollOnKeyboard } from './useHoldScrollOnKeyboard';

// A stand-in for Safari's visual viewport: the keyboard pans it by offsetTop.
class FakeViewport extends EventTarget {
  offsetTop = 0;
  height = 844;
  pan(by: number) {
    this.offsetTop = by;
    this.height = 844 - by;
    this.dispatchEvent(new Event('resize'));
  }
}

let viewport: FakeViewport;

function Harness({ prepare, onAdjust }: { prepare: (el: HTMLElement) => void; onAdjust?: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useHoldScrollOnKeyboard(ref, true, onAdjust);
  // A ref callback runs before effects, so the geometry is in place for the baseline.
  return <div ref={(node) => { ref.current = node; if (node) prepare(node); }} data-testid="scroller" />;
}

/** A 600px scroller over 3000px of content whose top sits 50px down the page. */
function scroller(el: HTMLElement, scrollTop: number) {
  let top = scrollTop;
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => 3000 },
    clientHeight: { configurable: true, get: () => 600 },
    scrollTop: { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(2400, v)); } },
  });
  el.getBoundingClientRect = () => ({ top: 50 } as DOMRect);
}

describe('useHoldScrollOnKeyboard', () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    vi.stubGlobal('visualViewport', viewport);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function mount(scrollTop: number, onAdjust?: () => void) {
    const view = render(<Harness prepare={(el) => scroller(el, scrollTop)} onAdjust={onAdjust} />);
    return view.getByTestId('scroller');
  }

  it('scrolls back by the pan when read above the bottom, and gives it back after', () => {
    const onAdjust = vi.fn();
    const el = mount(1000, onAdjust);
    viewport.pan(300);
    expect(el.scrollTop).toBe(700);
    expect(onAdjust).toHaveBeenCalled();
    viewport.pan(0);
    expect(el.scrollTop).toBe(1000);
  });

  it('lets the pan lift the content at the bottom', () => {
    const el = mount(2400);
    viewport.pan(300);
    expect(el.scrollTop).toBe(2400);
    viewport.pan(0);
    expect(el.scrollTop).toBe(2400);
  });

  it('gives back only what it could scroll back near the top', () => {
    const el = mount(100);
    viewport.pan(300);
    expect(el.scrollTop).toBe(0);
    viewport.pan(0);
    expect(el.scrollTop).toBe(100);
  });
});
