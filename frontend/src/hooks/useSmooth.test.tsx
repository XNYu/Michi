import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTypewriterCps, smoothingProfileForRuntime, useSmooth } from './useSmooth';

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

  it('maps only Kiro to the thicker smoothing profile', () => {
    expect(smoothingProfileForRuntime('kiro')).toBe('kiro');
    expect(smoothingProfileForRuntime('claude')).toBe('default');
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
});
