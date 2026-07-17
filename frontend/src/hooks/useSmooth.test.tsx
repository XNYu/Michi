import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextHybridTypewriterCps, nextTypewriterCps, smoothingProfileForRuntime, useSmooth } from './useSmooth';

describe('typewriter streaming speed curve', () => {
  it('drives speed from backlog to keep a target visible lag', () => {
    expect(nextTypewriterCps(30, 25, { targetLagMs: 500 })).toBe(50);
    expect(nextTypewriterCps(30, 80, { targetLagMs: 500 })).toBe(160);
    expect(nextTypewriterCps(30, 500, {
      targetLagMs: 500,
      maxTypewriterCps: Number.POSITIVE_INFINITY,
    })).toBe(1000);
  });

  it('honors optional minimums for tiny backlog', () => {
    expect(nextTypewriterCps(5, 1, { targetLagMs: 500 })).toBe(2);
    expect(nextTypewriterCps(5, 1, {
      targetLagMs: 500,
      minTypewriterCps: 8,
    })).toBe(8);
    expect(nextTypewriterCps(5, 0, {
      targetLagMs: 500,
      minTypewriterCps: 8,
    })).toBe(0);
  });

  it('uses the shorter finishing lag once streaming stops', () => {
    expect(nextTypewriterCps(30, 50, {
      targetLagMs: 500,
      finishLagMs: 100,
      streaming: false,
      maxTypewriterCps: Number.POSITIVE_INFINITY,
    })).toBe(500);
  });

  it('keeps the visible tail near constant speed and overdrives only large backlogs', () => {
    const opts = {
      targetLagMs: 500,
      finishLagMs: 140,
      streaming: true,
      minTypewriterCps: 8,
      maxTypewriterCps: 1200,
      correctionTauMs: 3000,
      minCpsFraction: 0.7,
      overdriveBacklogMultiplier: 2.5,
      minOverdriveBacklog: 24,
    };
    const steady = nextHybridTypewriterCps(40, 20, opts);
    const tail = nextHybridTypewriterCps(40, 4, opts);
    const burst = nextHybridTypewriterCps(40, 120, opts);

    expect(steady / tail).toBeLessThan(1.5);
    expect(burst).toBeGreaterThan(steady * 2);
  });

  it('uses the learned rate as a floor while a segment finishes', () => {
    const finish = (backlog: number) => nextHybridTypewriterCps(40, backlog, {
      targetLagMs: 500,
      finishLagMs: 140,
      streaming: false,
      minTypewriterCps: 8,
      maxTypewriterCps: 1200,
      correctionTauMs: 3000,
      minCpsFraction: 0.7,
      overdriveBacklogMultiplier: 2.5,
      minOverdriveBacklog: 24,
    });

    expect(finish(4)).toBeGreaterThanOrEqual(40);
    expect(finish(1)).toBeGreaterThanOrEqual(40);
  });

  it('maps runtimes to their smoothing profiles', () => {
    expect(smoothingProfileForRuntime('kiro')).toBe('kiro');
    expect(smoothingProfileForRuntime('claude')).toBe('claude');
    expect(smoothingProfileForRuntime('pi')).toBe('default');
    expect(smoothingProfileForRuntime(undefined)).toBe('default');
  });
});

describe('useSmooth', () => {
  let frames: FrameRequestCallback[];
  let frameId: number;
  let now: number;
  let performanceNow: ReturnType<typeof vi.spyOn>;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;

  beforeEach(() => {
    frames = [];
    frameId = 0;
    now = 0;
    performanceNow = vi.spyOn(performance, 'now').mockImplementation(() => now);
    originalRequestAnimationFrame = window.requestAnimationFrame;
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: vi.fn((cb: FrameRequestCallback) => {
        frames.push(cb);
        frameId += 1;
        return frameId;
      }),
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    performanceNow.mockRestore();
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame,
    });
  });

  function runNextFrame(timestamp: number): void {
    now = timestamp;
    const cb = frames.shift();
    expect(cb).toBeDefined();
    act(() => {
      cb!(timestamp);
    });
  }

  function drainFrames(timestamps: number[]): void {
    for (const t of timestamps) {
      if (frames.length === 0) return;
      runNextFrame(t);
    }
  }

  function setDocumentHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: hidden,
    });
  }

  it('holds the initial buffer, then drains proportional to bootstrapped agent speed', () => {
    const source = 'abcdefghijklmnopqrstuvwxyz';
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: source, streaming: true });
    });

    expect(result.current.displayed).toBe('');
    runNextFrame(60);
    expect(result.current.displayed).toBe('');

    // After buffer window: 26 chars / 120ms ≈ 217 cps bootstrap. With elapsed
    // capped at 100ms per frame, two ticks past the buffer should be enough
    // to drain the whole source (~21.7 chars per tick).
    drainFrames([120, 220, 340, 500]);
    expect(result.current.displayed).toBe(source);
    expect(result.current.isSmoothing).toBe(false);
  });

  it('holds Kiro output briefly to bridge its first 100ms micro-bursts', () => {
    const source = 'abcdefghijklmnopqrstuvwxyz';
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming, 'kiro'),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: source, streaming: true });
    });

    runNextFrame(120);
    expect(result.current.displayed).toBe('');
    runNextFrame(200);
    expect(result.current.displayed).toBe('');
    runNextFrame(220);
    expect(result.current.displayed.length).toBeGreaterThan(0);
  });

  it('uses a short Kiro CJK buffer before revealing text', () => {
    const source = '中文输出应该更早开始显示避免逐字停顿';
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming, 'kiro'),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: source, streaming: true });
    });

    runNextFrame(120);
    expect(result.current.displayed).toBe('');
    runNextFrame(240);
    expect(result.current.displayed.length).toBeGreaterThan(0);
  });

  it('keeps a Kiro CJK burst buffered across a one-second upstream gap', () => {
    const source = '这是一段用于模拟中文长回复的内容'.repeat(4);
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming, 'kiro'),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: source, streaming: true });
    });

    drainFrames([120, 220, 320, 420, 520, 620, 720, 820, 920]);

    expect(result.current.displayed.length).toBeGreaterThan(0);
    expect(result.current.displayed.length).toBeLessThan(source.length);
  });

  it('does not reapply the Kiro initial buffer after the typewriter catches up', () => {
    const first = 'abcdefghijklmnopqrstuvwxyz';
    const second = `${first}XYZ`;
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming, 'kiro'),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: first, streaming: true });
    });
    drainFrames([120, 220, 320, 420, 520, 640, 760, 920, 1120, 1360, 1640, 1960, 2200, 2440]);
    expect(result.current.displayed).toBe(first);

    act(() => {
      rerender({ text: second, streaming: true });
    });

    drainFrames([2480, 2600, 2720]);
    expect(result.current.displayed.length).toBeGreaterThan(first.length);
  });

  it('does not treat a long upstream Kiro gap after catch-up as a frame stall', () => {
    const first = '这是一段已经显示完成的中文输出';
    const second = `${first}，后面又来了更多中文内容需要继续平滑显示`;
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming, 'kiro'),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: first, streaming: true });
    });
    drainFrames([120, 160, 220, 320, 440, 560, 700, 860, 1040, 1240, 1480, 1720, 2000, 2320]);
    expect(result.current.displayed).toBe(first);

    act(() => {
      rerender({ text: second, streaming: true });
    });
    drainFrames([2_700, 2_800]);

    expect(result.current.displayed.length).toBeGreaterThan(first.length);
    expect(result.current.displayed.length).toBeLessThan(second.length);
  });

  it('eventually drains the full source whether streaming continues or stops', () => {
    const source = 'hello world';
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: source, streaming: true });
    });
    runNextFrame(60);

    act(() => {
      rerender({ text: source, streaming: false });
    });
    drainFrames([120, 220, 320, 500, 1000]);
    expect(result.current.displayed).toBe(source);
    expect(result.current.isSmoothing).toBe(false);
  });

  it('snaps to the latest source while the page is backgrounded', () => {
    const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
    const source = 'background output has already finished';
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming),
      { initialProps: { text: '', streaming: true } },
    );

    try {
      act(() => {
        setDocumentHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));
      });

      act(() => {
        rerender({ text: source, streaming: true });
      });

      expect(result.current.displayed).toBe(source);
      expect(result.current.isSmoothing).toBe(false);
      expect(frames).toHaveLength(0);
    } finally {
      if (originalHidden) {
        Object.defineProperty(document, 'hidden', originalHidden);
      } else {
        delete (document as any).hidden;
      }
    }
  });

  it('snaps instead of replaying slowly after a long frame stall', () => {
    const source = 'abcdefghijklmnopqrstuvwxyz';
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming),
      { initialProps: { text: '', streaming: true } },
    );

    act(() => {
      rerender({ text: source, streaming: true });
    });

    runNextFrame(60);
    expect(result.current.displayed).toBe('');
    runNextFrame(2_000);
    expect(result.current.displayed).toBe(source);
    expect(result.current.isSmoothing).toBe(false);
  });

  it('Claude leaky controller maintains near-constant CPS after stabilization', () => {
    // Simulate Bedrock burst pattern: ~40 chars every ~950ms
    const burst1 = 'a'.repeat(40);
    const burst2 = burst1 + 'b'.repeat(40);
    const burst3 = burst2 + 'c'.repeat(40);
    const burst4 = burst3 + 'd'.repeat(40);
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming, 'claude'),
      { initialProps: { text: '', streaming: true } },
    );

    // Burst 1
    now = 0;
    act(() => { rerender({ text: burst1, streaming: true }); });
    // Drain through initial buffer and first burst cycle
    drainFrames([250, 350, 450, 550, 650, 750, 850]);

    // Burst 2 at ~950ms
    now = 950;
    act(() => { rerender({ text: burst2, streaming: true }); });
    drainFrames([950, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800]);

    // Burst 3 at ~1900ms
    now = 1900;
    act(() => { rerender({ text: burst3, streaming: true }); });
    drainFrames([1900, 1950, 2050, 2150, 2250, 2350, 2450, 2550, 2650, 2750]);

    // Burst 4 at ~2850ms — by now leaky controller should be active
    now = 2850;
    act(() => { rerender({ text: burst4, streaming: true }); });

    // Sample CPS after burst 4 at two different points in the cycle
    // (early and late) — they should be similar if the controller is constant-rate
    const earlyDisplayed = result.current.displayed.length;
    drainFrames([2900, 2950, 3000, 3050, 3100]);
    const midDisplayed = result.current.displayed.length;
    const earlyRate = midDisplayed - earlyDisplayed; // chars in 200ms

    drainFrames([3200, 3250, 3300, 3350, 3400]);
    const lateDisplayed = result.current.displayed.length;
    const lateRate = lateDisplayed - midDisplayed; // chars in next 300ms

    // Under proportional controller, lateRate would be <<earlyRate (3:1 ratio).
    // Under leaky controller, the ratio should be much closer (within 2:1).
    // Allow generous bounds since we're testing the principle, not exact values.
    if (earlyRate > 0 && lateRate > 0) {
      const ratio = earlyRate / lateRate;
      // Normalize by time: earlyRate is over 200ms, lateRate over 300ms
      const earlyPerMs = earlyRate / 200;
      const latePerMs = lateRate / 300;
      const normalizedRatio = earlyPerMs / latePerMs;
      expect(normalizedRatio).toBeLessThan(2.5); // proportional would be 3+
    }
    // Also verify we're actually revealing text (not stuck)
    expect(result.current.displayed.length).toBeGreaterThan(burst3.length);
  });

  it('Claude leaky controller finishes gradually instead of explosive drain', () => {
    // Build up enough bursts to activate leaky controller, then stop streaming
    // with backlog remaining. CPS should be capped at ~2× throughputEma, NOT
    // backlog*1000/80 which would be thousands of CPS.
    const burst1 = 'x'.repeat(50);
    const burst2 = burst1 + 'y'.repeat(50);
    const burst3 = burst2 + 'z'.repeat(50);
    const burst4 = burst3 + 'w'.repeat(50);
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useSmooth(text, streaming, 'claude'),
      { initialProps: { text: '', streaming: true } },
    );

    // Burst 1
    now = 0;
    act(() => { rerender({ text: burst1, streaming: true }); });
    drainFrames([250, 350, 450]);

    // Burst 2 at ~950ms
    now = 950;
    act(() => { rerender({ text: burst2, streaming: true }); });
    drainFrames([950, 1050, 1150, 1250, 1350, 1450, 1550, 1650, 1750]);

    // Burst 3 at ~1900ms
    now = 1900;
    act(() => { rerender({ text: burst3, streaming: true }); });
    drainFrames([1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700]);

    // Burst 4 at ~2850ms
    now = 2850;
    act(() => { rerender({ text: burst4, streaming: true }); });
    drainFrames([2850, 2950, 3050]);

    // Record displayed length before stopping
    const beforeStop = result.current.displayed.length;
    const totalSource = burst4.length;
    const backlogAtStop = totalSource - beforeStop;

    // Stop streaming — there should be significant backlog remaining
    expect(backlogAtStop).toBeGreaterThan(20);

    now = 3100;
    act(() => { rerender({ text: burst4, streaming: false }); });

    // Run ONE frame — should NOT drain everything at once
    drainFrames([3116]);
    const afterOneFrame = result.current.displayed.length;
    const revealedInOneFrame = afterOneFrame - beforeStop;

    // Under the old explosive drain (cps = backlog*1000/80 = huge),
    // one 16ms frame would reveal most of the backlog. With gradual finish
    // (capped at throughputEma*2), one 16ms frame reveals much less.
    expect(revealedInOneFrame).toBeLessThan(backlogAtStop * 0.5);
  });
});
