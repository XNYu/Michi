import React, { useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePaneLayout } from './usePaneLayout';
import { paneEntrance, PANE_EASE } from './paneMotion';
import type { PaneWidthMode } from '../../state/paneLayout';

const animations: Array<{ cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }> = [];
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
  const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null };
  animations.push(animation);
  return animation as unknown as Animation;
});
const originalAnimate = HTMLElement.prototype.animate;
const customWidths: (number | undefined)[] = [];

function Harness({ ids, mode = 'adaptive', widths = customWidths, scope = 'tree-a', enabled = true, exitingIds, onExitStart, onExitComplete }: {
  ids: string[]; mode?: PaneWidthMode; widths?: (number | undefined)[]; scope?: string; enabled?: boolean; exitingIds?: ReadonlySet<string>;
  onExitStart?: (ids: readonly string[]) => void; onExitComplete?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const layout = usePaneLayout(ref, { paneIds: ids, customWidths: widths, mode, defaultPaneWidth: 800, enabled, scope, exitingIds, onExitStart, onExitComplete });
  return <div ref={ref} data-testid="strip" data-scroll-extent={layout.scrollExtent} style={{ display: 'grid', gridTemplateColumns: layout.gridTemplateColumns }}>
    {ids.map((id, i) => <div key={id} data-node-id={id} style={layout.paneStyles[i]}>{id}</div>)}
  </div>;
}

beforeEach(() => {
  animations.length = 0; animate.mockClear();
  HTMLElement.prototype.animate = animate as typeof HTMLElement.prototype.animate;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.stubGlobal('DOMMatrixReadOnly', class { m41 = 0; });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  HTMLElement.prototype.animate = originalAnimate;
});

describe('shared pane layout motion', () => {
  it('fully covers the trailing wrapper before the shared clock releases it', async () => {
    const onExitStart = vi.fn();
    const onExitComplete = vi.fn();
    const { rerender, getByTestId } = render(<Harness ids={['a', 'b', 'c', 'd']} onExitStart={onExitStart} onExitComplete={onExitComplete} />);
    rerender(<Harness ids={['a', 'b', 'c', 'd']} exitingIds={new Set(['d'])} onExitStart={onExitStart} onExitComplete={onExitComplete} />);
    expect(onExitStart).toHaveBeenCalledWith(['d']);
    expect(onExitComplete).not.toHaveBeenCalled();
    expect(animate).toHaveBeenLastCalledWith([
      { transform: 'translateX(0px)', clipPath: 'inset(0px 0px 0px 0px)' },
      { transform: 'translateX(0px)', clipPath: 'inset(0px 800px 0px 0px)' },
    ], expect.objectContaining({ duration: 160 }));
    const strip = getByTestId('strip');
    expect(strip.querySelector<HTMLElement>('[data-node-id="d"]')!.style.zIndex).toBe('0');
    expect(strip.querySelector<HTMLElement>('[data-node-id="c"]')!.style.zIndex).toBe('1');
    await act(async () => { animations[0].onfinish?.(); });
    expect(onExitComplete).toHaveBeenCalledExactlyOnceWith('d');
  });
  it('moves survivors while the closing pane is still mounted, with no second layout on removal', () => {
    const { rerender, getByTestId } = render(<Harness ids={['a', 'b', 'c']} />);
    rerender(<Harness ids={['a', 'b', 'c']} exitingIds={new Set(['b'])} />);
    const strip = getByTestId('strip');
    expect(strip.style.gridTemplateColumns).toBe('600px 600px');
    const closing = strip.querySelector<HTMLElement>('[data-node-id="b"]')!;
    expect(closing.style.position).toBe('absolute');
    expect(closing.style.width).toBe('800px');
    expect(closing.style.left).toBe('800px');
    expect(animate).toHaveBeenLastCalledWith([
      { transform: 'translateX(1000px)' }, { transform: 'translateX(0px)' },
    ], expect.objectContaining({ duration: 160 }));
    const calls = animate.mock.calls.length;
    rerender(<Harness ids={['a', 'c']} />);
    expect(animate).toHaveBeenCalledTimes(calls);
    expect(strip.style.gridTemplateColumns).toBe('600px 600px');
  });

  it.each(['a', 'b'])('waits for %s to close before expanding the survivor', id => {
    const { rerender, getByTestId } = render(<Harness ids={['a', 'b']} />);
    rerender(<Harness ids={['a', 'b']} exitingIds={new Set([id])} />);
    expect(getByTestId('strip').style.gridTemplateColumns).toBe('600px 600px');
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith([
      { transform: 'translateX(0px)', opacity: '1' },
      { transform: 'translateX(0px)', opacity: '0' },
    ], expect.objectContaining({ duration: 110 }));
    rerender(<Harness ids={[id === 'a' ? 'b' : 'a']} />);
    expect(getByTestId('strip').style.gridTemplateColumns).toBe('1200px');
    expect(animate).toHaveBeenLastCalledWith([
      { transform: `translateX(${id === 'a' ? 600 : 0}px)`, clipPath: 'inset(0px 600px 0px 0px)' },
      { transform: 'translateX(0px)', clipPath: 'inset(0px 0px 0px 0px)' },
    ], expect.objectContaining({ duration: 180 }));
  });

  it('retains the old scroll extent until the last exiting visual is removed', () => {
    const { rerender, getByTestId } = render(<Harness ids={['a', 'b', 'c', 'd']} />);
    expect(getByTestId('strip').dataset.scrollExtent).toBe('3400');
    rerender(<Harness ids={['a', 'b', 'c', 'd']} exitingIds={new Set(['d'])} />);
    expect(getByTestId('strip').dataset.scrollExtent).toBe('3400');
    rerender(<Harness ids={['a', 'b', 'c']} />);
    expect(getByTestId('strip').dataset.scrollExtent).toBe('2600');
  });

  it('commits final widths once and animates transforms only', () => {
    const { rerender, getByTestId } = render(<Harness ids={['a']} />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<Harness ids={['a', 'b']} />);
    expect(getByTestId('strip').style.gridTemplateColumns).toBe('600px 600px');
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledWith([
      { transform: 'translateX(0px)' }, { transform: 'translateX(0px)' },
    ], { duration: 220, easing: PANE_EASE, fill: 'both' });
    expect(animate.mock.contexts.every(element => element !== getByTestId('strip'))).toBe(true);
  });

  it('does not cancel motion for equivalent selector arrays', async () => {
    const { rerender } = render(<Harness ids={['a']} />);
    rerender(<Harness ids={['a', 'b']} widths={[undefined, undefined]} />);
    rerender(<Harness ids={['a', 'b']} widths={[undefined, undefined]} />);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animations[0].cancel).not.toHaveBeenCalled();
    await act(async () => { animations.forEach(animation => animation.onfinish?.()); });
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenCalledTimes(1);
  });

  it('keeps growing final-width panes disjoint instead of overlapping text', () => {
    const { rerender, getByTestId } = render(<Harness ids={['a', 'b']} />);
    rerender(<Harness ids={['a', 'b', 'c']} />);
    expect(getByTestId('strip').style.gridTemplateColumns).toBe('800px 800px 800px');
    for (const call of animate.mock.calls) {
      expect(call[0]).toEqual([{ transform: 'translateX(0px)' }, { transform: 'translateX(0px)' }]);
    }
  });

  it('moves remaining panes in at most 160ms after immediate close', () => {
    const { rerender, getByTestId } = render(<Harness ids={['a', 'b', 'c']} />);
    rerender(<Harness ids={['a', 'b']} />);
    expect(getByTestId('strip').style.gridTemplateColumns).toBe('600px 600px');
    expect(animate).toHaveBeenLastCalledWith([
      { transform: 'translateX(200px)' }, { transform: 'translateX(0px)' },
    ], expect.objectContaining({ duration: 160 }));
  });

  it('samples a running transform before cancellation when rapidly retargeting', () => {
    const { rerender } = render(<Harness ids={['a', 'b', 'c']} />);
    rerender(<Harness ids={['a', 'b']} />);
    const original = window.getComputedStyle;
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      expect(animations[0].cancel).not.toHaveBeenCalled();
      const style = original(element);
      style.transform = element.getAttribute('data-node-id') === 'b' ? 'matrix(1,0,0,1,100,0)' : 'none';
      return style;
    });
    vi.stubGlobal('DOMMatrixReadOnly', class { m41 = 100; });
    rerender(<Harness ids={['a', 'b']} mode="half" widths={[500, undefined]} />);
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith([
      { transform: 'translateX(200px)' }, { transform: 'translateX(0px)' },
    ], expect.objectContaining({ duration: 220 }));
  });

  it('applies manual widths immediately, including during an interrupted close', () => {
    const { rerender } = render(<Harness ids={['a', 'b', 'c']} />);
    rerender(<Harness ids={['a', 'b']} />);
    rerender(<Harness ids={['a', 'b']} widths={[520, undefined]} />);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(animations[0].cancel).toHaveBeenCalledTimes(1);
  });

  it('skips movement across tree switches and reduced motion', () => {
    const { rerender } = render(<Harness ids={['a', 'b']} />);
    rerender(<Harness ids={['c', 'd', 'e']} scope="tree-b" />);
    expect(animate).not.toHaveBeenCalled();
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    rerender(<Harness ids={['c', 'd']} scope="tree-b" />);
    expect(animate).not.toHaveBeenCalled();
  });

  it('cancels every animation on unmount', () => {
    const { rerender, unmount } = render(<Harness ids={['a']} />);
    rerender(<Harness ids={['a', 'b']} />);
    unmount();
    expect(animations.every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
  });

  it.each(['soft-fade', 'gentle-glide', 'frozen-retract', 'phosphor', 'fission', 'thread-pull'])('%s uses short unscaled entrances', mode => {
    const { frames, duration } = paneEntrance(mode);
    expect(duration).toBeGreaterThanOrEqual(150);
    expect(duration).toBeLessThanOrEqual(220);
    expect(frames.every(frame => Object.keys(frame).every(key => key === 'opacity' || key === 'transform'))).toBe(true);
    expect(frames.every(frame => !String(frame.transform).includes('scale'))).toBe(true);
  });
});
