import { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickActiveSection, revealInScroller, useScrollSpy, type ScrollSpy } from './useScrollSpy';

describe('pickActiveSection', () => {
  const base = { scrollTop: 400, scrollHeight: 3000, clientHeight: 600 };

  it('returns -1 when there are no sections', () => {
    expect(pickActiveSection({ ...base, tops: [] })).toBe(-1);
  });

  it('picks the last section whose heading crossed the reading line', () => {
    // Reading line = 600 * 0.3 = 180px below the viewport top.
    expect(pickActiveSection({ ...base, tops: [-400, -50, 150, 500] })).toBe(2);
    expect(pickActiveSection({ ...base, tops: [-400, -50, 200, 500] })).toBe(1);
  });

  it('keeps the first section current at the very top, even for a short document', () => {
    expect(pickActiveSection({ tops: [40, 120, 160], scrollTop: 0, scrollHeight: 500, clientHeight: 600 })).toBe(0);
  });

  it('makes the last section current once scrolled to the end', () => {
    expect(pickActiveSection({ tops: [-2000, -300, 350, 500], scrollTop: 2400, scrollHeight: 3000, clientHeight: 600 })).toBe(3);
  });
});

interface Layout {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  tops: Record<string, number>;
}

const sectionElement = (id: string) => document.getElementById(`s-${id}`);

describe('useScrollSpy', () => {
  let frames: FrameRequestCallback[];
  let layout: Layout;
  let latest: ScrollSpy;

  function Harness({ ids }: { ids: string[] }) {
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    latest = useScrollSpy(container, ids, sectionElement);
    return (
      <div ref={setContainer} data-testid="scroller">
        {ids.map((id) => <section key={id} id={`s-${id}`} />)}
      </div>
    );
  }

  function mount(ids: string[]) {
    const view = render(<Harness ids={ids} />);
    const scroller = view.getByTestId('scroller');
    for (const key of ['scrollTop', 'scrollHeight', 'clientHeight'] as const) {
      Object.defineProperty(scroller, key, { configurable: true, get: () => layout[key] });
    }
    return { ...view, scroller };
  }

  function flushFrames() {
    act(() => {
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback(0));
    });
  }

  function scrollTo(scroller: HTMLElement, next: Partial<Layout>) {
    layout = { ...layout, ...next };
    fireEvent.scroll(scroller);
    flushFrames();
  }

  beforeEach(() => {
    frames = [];
    layout = {
      scrollTop: 0,
      scrollHeight: 3000,
      clientHeight: 600,
      tops: { a: 40, b: 450, c: 850, d: 1300 },
    };
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.id.startsWith('s-') ? this.id.slice(2) : null;
      const top = id ? layout.tops[id] - layout.scrollTop : 0;
      return { top, bottom: top + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: top, toJSON: () => ({}) };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts on the first section and follows the reader down the page', () => {
    const { scroller } = mount(['a', 'b', 'c', 'd']);
    expect(latest.activeId).toBe('a');

    // c sits at 850 - 700 = 150px, above the 180px reading line.
    scrollTo(scroller, { scrollTop: 700 });
    expect(latest.activeId).toBe('c');

    scrollTo(scroller, { scrollTop: 2400 });
    expect(latest.activeId).toBe('d');
  });

  it('holds a pinned section through programmatic scrolling until the user scrolls', () => {
    const { scroller } = mount(['a', 'b', 'c', 'd']);
    scrollTo(scroller, { scrollTop: 700 });

    act(() => latest.pin('a'));
    expect(latest.activeId).toBe('a');

    // Smooth scrollIntoView passes over other sections; the pin must not flicker.
    scrollTo(scroller, { scrollTop: 400 });
    expect(latest.activeId).toBe('a');

    fireEvent.wheel(scroller);
    scrollTo(scroller, { scrollTop: 700 });
    expect(latest.activeId).toBe('c');
  });

  it('releases the pin on scrollend without overriding the clicked section', () => {
    const { scroller } = mount(['a', 'b', 'c', 'd']);
    scrollTo(scroller, { scrollTop: 700 });

    act(() => latest.pin('d'));
    fireEvent(scroller, new Event('scrollend'));
    // A short trailing section clicked from the outline stays current.
    expect(latest.activeId).toBe('d');

    scrollTo(scroller, { scrollTop: 400 });
    expect(latest.activeId).toBe('b');
  });

  it('falls back to the first section when the current one disappears', () => {
    const { rerender } = mount(['a', 'b', 'c', 'd']);
    act(() => latest.pin('d'));
    rerender(<Harness ids={['a', 'b']} />);
    expect(latest.activeId).toBe('a');
  });
});

describe('revealInScroller', () => {
  function scroller(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
    const element = document.createElement('nav');
    for (const [key, value] of Object.entries(metrics)) {
      Object.defineProperty(element, key, { configurable: true, value });
    }
    Object.defineProperty(element, 'clientTop', { configurable: true, value: 0 });
    element.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    element.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
    return element;
  }

  function child(top: number, height = 30) {
    const element = document.createElement('button');
    element.getBoundingClientRect = () => ({ top, bottom: top + height } as DOMRect);
    return element;
  }

  it('leaves the scroller alone when the item is already visible', () => {
    const nav = scroller({ scrollTop: 0, scrollHeight: 900, clientHeight: 300 });
    revealInScroller(nav, child(200), { padding: 24 });
    expect(nav.scrollTo).not.toHaveBeenCalled();
  });

  it('scrolls down just enough to show an item below the fold', () => {
    const nav = scroller({ scrollTop: 50, scrollHeight: 900, clientHeight: 300 });
    // Item spans 420..450 relative to the nav's top edge; the visible limit is 300 - 24.
    revealInScroller(nav, child(520), { padding: 24, behavior: 'smooth' });
    expect(nav.scrollTo).toHaveBeenCalledWith({ top: 50 + 174, behavior: 'smooth' });
  });

  it('scrolls up to show an item above the fold', () => {
    const nav = scroller({ scrollTop: 400, scrollHeight: 900, clientHeight: 300 });
    revealInScroller(nav, child(90), { padding: 24 });
    expect(nav.scrollTo).toHaveBeenCalledWith({ top: 400 - 34, behavior: 'auto' });
  });

  it('does nothing when the scroller does not overflow', () => {
    const nav = scroller({ scrollTop: 0, scrollHeight: 300, clientHeight: 300 });
    revealInScroller(nav, child(900), { padding: 24 });
    expect(nav.scrollTo).not.toHaveBeenCalled();
  });
});
