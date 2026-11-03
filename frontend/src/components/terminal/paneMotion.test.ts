import { describe, expect, it } from 'vitest';
import { PANE_MOTION_OPTIONS, paneEntrance, paneMotionTiming } from './paneMotion';

describe('paneEntrance', () => {
  it.each(PANE_MOTION_OPTIONS.map(([mode]) => mode))('%s moves the content of a new pane', (mode) => {
    const { frames: [from, to] } = paneEntrance(mode);
    expect(from.transform).not.toBe(to.transform);
    expect(to.transform).toBe('translate(0px, 0px)');
  });

  it('drifts the default in from the side the pane arrives on, in step with its timing', () => {
    expect(paneEntrance('soft-fade').frames[0].transform).toBe('translateX(8px)');
    expect(paneEntrance('soft-fade', { from: 'left' }).frames[0].transform).toBe('translateX(-8px)');
    expect(paneEntrance('soft-fade').duration).toBe(paneMotionTiming('soft-fade').enter);
    for (const [mode] of PANE_MOTION_OPTIONS) expect(paneEntrance(mode).duration).toBe(paneMotionTiming(mode).enter);
  });

  it('pulls a new branch out of its parent under the default, and leaves chosen presets alone', () => {
    const branch = paneEntrance('soft-fade', { branch: true });
    expect(branch.frames[0].transform).toBe('translateX(16px)');
    expect(paneEntrance('soft-fade', { branch: true, from: 'left' }).frames[0].transform).toBe('translateX(-16px)');
    expect(branch.duration).toBe(paneEntrance('thread-pull').duration);
    for (const mode of ['fission', 'gentle-glide', 'frozen-retract', 'thread-pull', 'phosphor']) {
      expect(paneEntrance(mode, { branch: true, from: 'left' })).toEqual(paneEntrance(mode));
    }
  });

  it('never fades: the populated content stays opaque over the pane', () => {
    for (const [mode] of PANE_MOTION_OPTIONS) {
      for (const branch of [false, true]) {
        expect(paneEntrance(mode, { branch }).frames.every((frame) => frame.opacity === 1)).toBe(true);
      }
    }
  });
});
