import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCameraSnapshot, useMapCamera, type MapCameraController } from './useMapCamera';
import type { Camera } from './mapCamera';

const viewport = { width: 800, height: 600 };
const content = { width: 2000, height: 1500 };

let controller: MapCameraController | null = null;
let renders = 0;

function Pill({ camera }: { camera: MapCameraController }) {
  const { k, auto } = useCameraSnapshot(camera);
  return <span data-testid="pill">{`${Math.round(k * 100)}|${auto ? 'auto' : 'manual'}`}</span>;
}

function Harness({ autoTarget }: { autoTarget: Camera | null }) {
  renders += 1;
  const camera = useMapCamera({ viewport, content, autoTarget });
  controller = camera;
  return (
    <div data-testid="surface" ref={camera.bindSurface}>
      <div data-testid="world" ref={camera.bindWorld}>
        <div data-map-node="n1" data-testid="card" />
      </div>
      <Pill camera={camera} />
    </div>
  );
}

function parseTransform(el: HTMLElement): Camera {
  const m = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px, 0\) scale\(([-\d.e]+)\)/.exec(el.style.transform);
  if (!m) throw new Error(`unexpected transform: ${el.style.transform}`);
  return { x: Number(m[1]), y: Number(m[2]), k: Number(m[3]) };
}

function flushFrames(ms = 400) {
  act(() => { vi.advanceTimersByTime(ms); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  controller = null;
  renders = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useMapCamera', () => {
  it('applies the auto target before paint and reports it to the pill', () => {
    const { getByTestId } = render(<Harness autoTarget={{ x: 10, y: 20, k: 1.25 }} />);
    expect(parseTransform(getByTestId('world'))).toEqual({ x: 10, y: 20, k: 1.25 });
    expect(getByTestId('pill').textContent).toBe('125|auto');
  });

  it('pinch-zooms at the cursor without re-rendering the host', () => {
    const { getByTestId } = render(<Harness autoTarget={{ x: 0, y: 0, k: 1 }} />);
    const surface = getByTestId('surface');
    const world = getByTestId('world');
    const rendersBefore = renders;

    const wheel = new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, clientX: 200, clientY: 100, bubbles: true, cancelable: true });
    act(() => { surface.dispatchEvent(wheel); });
    expect(wheel.defaultPrevented).toBe(true);
    flushFrames(16);

    const cam = parseTransform(world);
    expect(cam.k).toBeGreaterThan(1);
    // World point (200,100) stays under the cursor.
    expect(200 * cam.k + cam.x).toBeCloseTo(200);
    expect(100 * cam.k + cam.y).toBeCloseTo(100);
    expect(world.style.willChange).toBe('transform');
    expect(world.style.pointerEvents).toBe('none');
    expect(renders).toBe(rendersBefore);
    expect(getByTestId('pill').textContent).toMatch(/\|manual$/);

    // Once input settles the layer is released so text re-rasters crisply.
    flushFrames(400);
    expect(world.style.willChange).toBe('');
    expect(world.style.pointerEvents).toBe('');
  });

  it('pans on a plain two-finger scroll', () => {
    const { getByTestId } = render(<Harness autoTarget={{ x: 0, y: 0, k: 1 }} />);
    act(() => {
      getByTestId('surface').dispatchEvent(new WheelEvent('wheel', { deltaX: 30, deltaY: 50, bubbles: true, cancelable: true }));
    });
    flushFrames(16);
    expect(parseTransform(getByTestId('world'))).toEqual({ x: -30, y: -50, k: 1 });
  });

  it('drag-pans from empty canvas but not from a card', () => {
    const { getByTestId } = render(<Harness autoTarget={{ x: 0, y: 0, k: 1 }} />);
    const surface = getByTestId('surface');
    surface.setPointerCapture = vi.fn();
    surface.releasePointerCapture = vi.fn();
    surface.hasPointerCapture = vi.fn(() => true);
    const pointer = (type: string, target: Element, x: number, y: number) =>
      act(() => {
        const e = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as MouseEvent & { pointerId: number };
        Object.defineProperty(e, 'pointerId', { value: 1 });
        target.dispatchEvent(e);
      });

    pointer('pointerdown', getByTestId('card'), 0, 0);
    pointer('pointermove', surface, 80, 40);
    flushFrames(16);
    expect(parseTransform(getByTestId('world'))).toEqual({ x: 0, y: 0, k: 1 });
    pointer('pointerup', surface, 80, 40);

    pointer('pointerdown', surface, 0, 0);
    pointer('pointermove', surface, 80, 40);
    flushFrames(16);
    expect(parseTransform(getByTestId('world'))).toEqual({ x: 80, y: 40, k: 1 });
    pointer('pointerup', surface, 80, 40);
    expect(surface.style.cursor).toBe('');
  });

  it('stops following auto targets after manual zoom until FIT', () => {
    const { getByTestId, rerender } = render(<Harness autoTarget={{ x: 0, y: 0, k: 1 }} />);
    act(() => { controller!.zoomIn(); });
    flushFrames();
    expect(parseTransform(getByTestId('world')).k).toBeCloseTo(1.2);

    rerender(<Harness autoTarget={{ x: 5, y: 5, k: 0.9 }} />);
    flushFrames();
    expect(parseTransform(getByTestId('world')).k).toBeCloseTo(1.2);

    act(() => { controller!.fit(); });
    flushFrames();
    expect(parseTransform(getByTestId('world'))).toEqual({ x: 5, y: 5, k: 0.9 });
    expect(getByTestId('pill').textContent).toBe('90|auto');
  });
});
