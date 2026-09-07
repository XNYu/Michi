import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollWithPaneLayout } from './paneReveal';

let frame: FrameRequestCallback | undefined;
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(callback => { frame = callback; return 1; }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const strip = document.createElement('div');
  strip.scrollLeft = 100;
  let progress = 0;
  const animation = Object.assign(new EventTarget(), {
    effect: { getComputedTiming: () => ({ progress }) },
  }) as unknown as Animation;
  const mirror = vi.fn();
  const stop = scrollWithPaneLayout(strip, animation, 1100, mirror);
  return { strip, animation, mirror, stop, step: (value: number) => { progress = value; frame?.(0); } };
}

describe('pane reveal', () => {
  it('does not run another clock when there is no horizontal movement', () => {
    const strip = document.createElement('div');
    strip.scrollLeft = 100;
    const mirror = vi.fn();
    scrollWithPaneLayout(strip, new EventTarget() as Animation, 100, mirror);
    expect(mirror).toHaveBeenCalledWith(100);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
  it('scrolls and mirrors captions during the layout animation, using its eased progress', () => {
    const { strip, animation, mirror, step } = setup();
    step(0.25);
    expect(strip.scrollLeft).toBe(350);
    expect(mirror).toHaveBeenLastCalledWith(350);
    step(0.75);
    expect(strip.scrollLeft).toBe(850);
    animation.dispatchEvent(new Event('finish'));
    expect(strip.scrollLeft).toBe(1100);
  });

  for (const input of ['wheel', 'pointerdown', 'touchstart']) {
    it(`stops without a late jump when the user takes over with ${input}`, () => {
      const { strip, animation, step } = setup();
      step(0.3);
      strip.dispatchEvent(new Event(input));
      step(0.8);
      animation.dispatchEvent(new Event('finish'));
      expect(strip.scrollLeft).toBe(400);
    });
  }

  it('cancels an interrupted reveal and starts the next one at the current offset', () => {
    const { strip, animation, step } = setup();
    step(0.4);
    animation.dispatchEvent(new Event('cancel'));
    step(0.8);
    expect(strip.scrollLeft).toBe(500);
    scrollWithPaneLayout(strip, animation, 1500, vi.fn());
    step(0.5);
    expect(strip.scrollLeft).toBe(1000);
  });

  it('cleans up on unmount', () => {
    const { strip, animation, step, stop } = setup();
    stop();
    step(0.5);
    animation.dispatchEvent(new Event('finish'));
    expect(strip.scrollLeft).toBe(100);
  });
});
