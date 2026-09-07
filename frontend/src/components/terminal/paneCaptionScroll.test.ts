import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindPaneCaptionScroll } from './paneCaptionScroll';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup(native = false) {
  const strip = document.createElement('div');
  const viewport = document.createElement('div');
  const captions = document.createElement('div');
  const pane = document.createElement('div');
  pane.dataset.nodeId = 'a';
  strip.append(pane);
  viewport.append(captions);
  document.body.append(strip, viewport);
  const width = vi.spyOn(strip, 'scrollWidth', 'get').mockReturnValue(2400);
  vi.spyOn(strip, 'clientWidth', 'get').mockReturnValue(1000);
  strip.scrollLeft = 320;
  strip.scrollBy = vi.fn();
  let resize!: ResizeObserverCallback;
  const disconnect = vi.fn();
  const observe = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  const timeline = {};
  const Timeline = vi.fn(function () { return timeline; });
  vi.stubGlobal('ScrollTimeline', native ? Timeline : undefined);
  const cancel = vi.fn();
  const setKeyframes = vi.fn();
  captions.animate = vi.fn(() => ({ cancel, effect: { setKeyframes } }) as unknown as Animation);
  const dispose = bindPaneCaptionScroll(strip, captions);
  return { strip, captions, viewport, width, resize: () => resize([], {} as ResizeObserver),
    disconnect, observe, Timeline, timeline, cancel, setKeyframes, dispose };
}

describe('pane caption scrolling', () => {
  it('initializes restored positions and mirrors only from the dashboard', () => {
    const { strip, captions, dispose } = setup();
    expect(captions.style.transform).toBe('translateX(-320px)');
    strip.scrollLeft = 780;
    strip.dispatchEvent(new Event('scroll'));
    expect(captions.style.transform).toBe('translateX(-780px)');
    expect(captions.scrollLeft).toBe(0);
    captions.dispatchEvent(new Event('scroll'));
    expect(strip.scrollLeft).toBe(780);
    dispose();
  });

  it('binds the native animation to the dashboard and updates resized ranges', () => {
    const { strip, captions, Timeline, timeline, width, resize, setKeyframes, dispose, cancel } = setup(true);
    expect(Timeline).toHaveBeenCalledWith({ source: strip, axis: 'x' });
    expect(captions.animate).toHaveBeenCalledWith([
      { transform: 'translateX(0px)' }, { transform: 'translateX(-1400px)' },
    ], { timeline, fill: 'both', easing: 'linear' });
    strip.scrollLeft = 500;
    strip.dispatchEvent(new Event('scroll'));
    expect(captions.style.transform).toBe('translateX(-320px)');
    width.mockReturnValue(2800);
    resize();
    expect(setKeyframes).toHaveBeenLastCalledWith([
      { transform: 'translateX(0px)' }, { transform: 'translateX(-1800px)' },
    ]);
    expect(captions.animate).toHaveBeenCalledTimes(1);
    dispose();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    [{ deltaX: -75 }, -75],
    [{ deltaY: 60, shiftKey: true }, 60],
    [{ deltaX: 2, deltaMode: 1 }, 32],
    [{ deltaX: -1, deltaMode: 2 }, -1000],
  ])('routes horizontal title input to the single scroll owner: %o', (options, left) => {
    const { strip, viewport, dispose } = setup();
    const wheel = new WheelEvent('wheel', { ...options, cancelable: true });
    viewport.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(strip.scrollBy).toHaveBeenCalledWith({ left, behavior: 'instant' });
    dispose();
  });

  it('does not hijack vertical scrolling or zoom gestures', () => {
    const { strip, viewport, dispose } = setup();
    for (const options of [{ deltaY: 60 }, { deltaX: 60, ctrlKey: true }, { deltaX: 60, metaKey: true }]) {
      const wheel = new WheelEvent('wheel', { ...options, cancelable: true });
      viewport.dispatchEvent(wheel);
      expect(wheel.defaultPrevented).toBe(false);
    }
    expect(strip.scrollBy).not.toHaveBeenCalled();
    dispose();
  });

  it('releases observers, wheel listeners and fallback transforms on unmount', () => {
    const { strip, captions, viewport, dispose, disconnect, observe } = setup();
    expect(observe).toHaveBeenCalledTimes(2);
    dispose();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(captions.style.transform).toBe('');
    strip.dispatchEvent(new Event('scroll'));
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaX: 60 }));
    expect(captions.style.transform).toBe('');
    expect(strip.scrollBy).not.toHaveBeenCalled();
  });
});
