import { fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEdgeSwipe, useSwipeLeft } from './useEdgeSwipe';

function Harness({ enabled = true, onSwipe }: { enabled?: boolean; onSwipe: () => void }) {
  useEdgeSwipe(enabled, onSwipe);
  return (
    <div>
      <div data-testid="content">content</div>
      <div data-testid="map"><span data-testid="inside-map">map</span></div>
    </div>
  );
}

const point = (x: number, y: number) => ({ identifier: 1, clientX: x, clientY: y });

function swipe(target: Element, path: Array<[number, number]>) {
  const [first, ...rest] = path;
  fireEvent.touchStart(target, { touches: [point(...first)] });
  for (const p of rest) fireEvent.touchMove(target, { touches: [point(...p)] });
  fireEvent.touchEnd(target, { touches: [] });
}

describe('useEdgeSwipe', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('fires once for a rightward swipe that starts at the left edge', () => {
    const onSwipe = vi.fn();
    const view = render(<Harness onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[8, 300], [30, 302], [70, 305], [120, 306]]);
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it('ignores swipes that start away from the edge', () => {
    const onSwipe = vi.fn();
    const view = render(<Harness onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[60, 300], [140, 300]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('leaves a vertical scroll from the edge alone', () => {
    const onSwipe = vi.fn();
    const view = render(<Harness onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[8, 300], [12, 330], [70, 340]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('ignores a second finger', () => {
    const onSwipe = vi.fn();
    const view = render(<Harness onSwipe={onSwipe} />);
    const target = view.getByTestId('content');
    fireEvent.touchStart(target, { touches: [point(8, 300), { identifier: 2, clientX: 200, clientY: 300 }] });
    fireEvent.touchMove(target, { touches: [point(80, 300), { identifier: 2, clientX: 260, clientY: 300 }] });
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('leaves content that takes every touch to that content', () => {
    const onSwipe = vi.fn();
    const view = render(<Harness onSwipe={onSwipe} />);
    // jsdom does not implement touch-action; browsers report it as computed style.
    const map = view.getByTestId('map');
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      el === map ? ({ touchAction: 'none' } as CSSStyleDeclaration) : real(el, pseudo));
    try {
      swipe(view.getByTestId('inside-map'), [[8, 300], [80, 300]]);
      expect(onSwipe).not.toHaveBeenCalled();
      swipe(view.getByTestId('content'), [[8, 300], [80, 300]]);
      expect(onSwipe).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('stays off while a modal is open', () => {
    const onSwipe = vi.fn();
    const view = render(<Harness onSwipe={onSwipe} />);
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    swipe(view.getByTestId('content'), [[8, 300], [80, 300]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onSwipe = vi.fn();
    const view = render(<Harness enabled={false} onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[8, 300], [80, 300]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });
});

function LeftHarness({ enabled = true, onSwipe }: { enabled?: boolean; onSwipe: () => void }) {
  useSwipeLeft(enabled, onSwipe);
  return <div data-testid="content">content</div>;
}

describe('useSwipeLeft', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('fires once for a leftward swipe that starts anywhere', () => {
    const onSwipe = vi.fn();
    const view = render(<LeftHarness onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[260, 300], [230, 302], [190, 305], [150, 306]]);
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });

  it('ignores a rightward swipe', () => {
    const onSwipe = vi.fn();
    const view = render(<LeftHarness onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[100, 300], [200, 300]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('leaves a vertical scroll alone', () => {
    const onSwipe = vi.fn();
    const view = render(<LeftHarness onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[200, 300], [196, 330], [140, 340]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', () => {
    const onSwipe = vi.fn();
    const view = render(<LeftHarness enabled={false} onSwipe={onSwipe} />);
    swipe(view.getByTestId('content'), [[200, 300], [120, 300]]);
    expect(onSwipe).not.toHaveBeenCalled();
  });
});
