import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AnimatePresence, MotionConfig, MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoverTip, PopoverSurface, Tooltip } from './Popover';

describe('menu surface isolation', () => {
  it('only opts the requested surface into the exported menu tokens', () => {
    render(<>
      <PopoverSurface menuKind="workspace" role="menu">Workspace options</PopoverSurface>
      <PopoverSurface variant="tooltip" role="tooltip">Original icon hint</PopoverSurface>
      <PopoverSurface role="dialog">Original unrelated panel</PopoverSurface>
    </>);
    expect(screen.getByRole('menu').classList.contains('michi-menu')).toBe(true);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.classList.contains('michi-menu')).toBe(false);
    expect(tooltip.style.borderRadius).toBe('var(--ui-tooltip-radius)');
    expect(tooltip.style.fontSize).toBe('var(--fs-sm)');
    const dialog = screen.getByRole('dialog');
    expect(dialog.classList.contains('michi-menu')).toBe(false);
    expect(dialog.style.borderRadius).toBe('var(--ui-popover-radius)');
  });
});

describe('menu surface motion', () => {
  it('grows menus with motion and leaves autocompletes and tooltips on their CSS fade', () => {
    render(<>
      <PopoverSurface menuKind="composer" role="menu">Models</PopoverSurface>
      <PopoverSurface menuKind="slash" role="listbox">Commands</PopoverSurface>
      <PopoverSurface variant="tooltip" role="tooltip" animate>Hint</PopoverSurface>
    </>);
    const menu = screen.getByRole('menu');
    expect(menu.getAttribute('data-menu-animate')).toBe('true');
    expect(menu.getAttribute('data-menu-motion')).toBe('grow');
    expect(menu.style.animation).toBe('');
    const list = screen.getByRole('listbox');
    expect(list.getAttribute('data-menu-animate')).toBe('true');
    expect(list.hasAttribute('data-menu-motion')).toBe(false);
    expect(screen.getByRole('tooltip').style.animation).toContain('fadeIn');
  });

  it('fades out inside AnimatePresence as a ghost that is no longer a menu', async () => {
    let node: HTMLDivElement | null = null;
    const view = render(<AnimatePresence>{<PopoverSurface key="menu" ref={(el) => { node = el; }} menuKind="context" role="menu" aria-label="Actions"><button>Rename</button></PopoverSurface>}</AnimatePresence>);
    const menu = screen.getByRole('menu', { name: 'Actions' });
    expect(node).toBe(menu);
    view.rerender(<AnimatePresence>{null}</AnimatePresence>);
    // Esc routing matches [role="menu"] whether hidden or not.
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(menu.getAttribute('aria-hidden')).toBe('true');
    expect(menu.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(menu.isConnected).toBe(false));
  });

  // jsdom has no Web Animations: record what the surface asks for.
  describe('with animations running', () => {
    type Entrance = { keyframes: Keyframe[]; options: KeyframeAnimationOptions; animation: { cancel: ReturnType<typeof vi.fn>; commitStyles: ReturnType<typeof vi.fn>; playState: string } };
    let entrances: Entrance[] = [];
    const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    beforeEach(() => {
      MotionGlobalConfig.skipAnimations = false;
      entrances = [];
      HTMLElement.prototype.animate = function (keyframes, options) {
        const animation = { cancel: vi.fn(), commitStyles: vi.fn(), playState: 'running' };
        entrances.push({ keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions, animation });
        return animation as unknown as Animation;
      };
    });
    afterEach(() => {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
      vi.restoreAllMocks();
      MotionGlobalConfig.skipAnimations = true;
    });

    it('holds transparent and unscaled while the caller places it, then grows from the press that opened it', async () => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 100, y: 200, width: 200, height: 100 }));
      window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 120, clientY: 180 }));
      render(<PopoverSurface menuKind="context" role="menu" left={100} top={200}>Actions</PopoverSurface>);
      const menu = screen.getByRole('menu');
      expect(entrances).toHaveLength(1);
      const [{ keyframes, options }] = entrances;
      expect(keyframes[0]).toMatchObject({ offset: 0, opacity: 0, transform: 'none', easing: 'step-end' });
      expect(keyframes[1]).toMatchObject({ opacity: 0, transform: 'scale(0.97)' });
      expect(keyframes[2]).toMatchObject({ offset: 1, opacity: 1, transform: 'none' });
      expect(options.duration).toBeGreaterThan(120);
      expect(menu.style.transformOrigin).toBe('top left');
      // Above the menu's top edge, 20px in: the trigger it opened from.
      await waitFor(() => expect(menu.style.transformOrigin).toBe('20px 0px'));
    });

    it('grows from its anchored corner when the keyboard opened it after a click elsewhere', async () => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 100, y: 200, width: 200, height: 100 }));
      window.dispatchEvent(new MouseEvent('pointerdown', { clientX: 120, clientY: 180 }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      render(<PopoverSurface menuKind="composer" role="menu" right={20} bottom={40}>Models</PopoverSurface>);
      await twoFrames();
      await twoFrames();
      expect(screen.getByRole('menu').style.transformOrigin).toBe('bottom right');
    });

    it('only fades in under reduced motion', () => {
      render(<MotionConfig reducedMotion="always"><PopoverSurface menuKind="context" role="menu">Actions</PopoverSurface></MotionConfig>);
      expect(entrances.map((entrance) => entrance.keyframes)).toEqual([[{ opacity: 0 }, { opacity: 1 }]]);
      expect(screen.getByRole('menu').style.transformOrigin).toBe('');
    });

    it('hands a running entrance over to the exit where it got to', () => {
      const view = render(<AnimatePresence><PopoverSurface key="menu" menuKind="context" role="menu">Actions</PopoverSurface></AnimatePresence>);
      const [{ animation }] = entrances;
      view.rerender(<AnimatePresence>{null}</AnimatePresence>);
      expect(animation.commitStyles).toHaveBeenCalledOnce();
      expect(animation.cancel).toHaveBeenCalled();
    });
  });
});

describe('HoverTip', () => {
  it('delays hover, shows immediately on focus, and hides on blur', () => {
    vi.useFakeTimers();
    try {
      render(<HoverTip label="Help" delayMs={400}><button type="button">?</button></HoverTip>);
      const anchor = screen.getByRole('button');
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.mouseEnter(anchor);
      act(() => { vi.advanceTimersByTime(399); });
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('tooltip').textContent).toContain('Help');

      fireEvent.mouseLeave(anchor);
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.focus(anchor);
      expect(screen.getByRole('tooltip').textContent).toContain('Help');
      fireEvent.blur(anchor);
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes an open tip when disabled and never opens while disabled', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <HoverTip label="Help" delayMs={0}><button type="button">?</button></HoverTip>,
      );
      fireEvent.mouseEnter(screen.getByRole('button'));
      expect(screen.getByRole('tooltip')).toBeTruthy();

      rerender(<HoverTip label="Help" delayMs={0} disabled><button type="button">?</button></HoverTip>);
      expect(screen.queryByRole('tooltip')).toBeNull();

      fireEvent.focus(screen.getByRole('button'));
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the anchor ref and chains the anchor handlers', () => {
    let node: HTMLButtonElement | null = null;
    const onMouseEnter = vi.fn();
    render(
      <HoverTip label="Help" delayMs={0}>
        <button ref={(el) => { node = el; }} type="button" onMouseEnter={onMouseEnter}>?</button>
      </HoverTip>,
    );
    expect(node).toBe(screen.getByRole('button'));
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
  });
});

// jsdom has no PointerEvent, so fireEvent would drop pointerType.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

describe('tooltips after a tap', () => {
  beforeEach(() => { vi.stubGlobal('PointerEvent', TestPointerEvent); });
  // A tap fires pointer events with pointerType "touch", then compatibility
  // mouseenter and (on Android) focus, and no mouseleave until the next tap.
  function tap(el: Element) {
    fireEvent.pointerOver(el, { pointerType: 'touch' });
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    fireEvent.mouseEnter(el);
    fireEvent.focus(el);
  }

  afterEach(() => {
    fireEvent.pointerOver(document.body, { pointerType: 'mouse' });
    vi.unstubAllGlobals();
  });

  it('HoverTip ignores the synthetic hover and focus of a tap', () => {
    render(<HoverTip label="Help" delayMs={0}><button type="button">?</button></HoverTip>);
    const anchor = screen.getByRole('button');
    tap(anchor);
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseLeave(anchor);
    fireEvent.pointerOver(anchor, { pointerType: 'mouse' });
    fireEvent.mouseEnter(anchor);
    expect(screen.getByRole('tooltip').textContent).toContain('Help');
  });

  it('a Tooltip mounted by a tap renders nothing', () => {
    function IconWithTip() {
      const ref = React.useRef<HTMLButtonElement>(null);
      const [hover, setHover] = React.useState(false);
      return <>
        <button ref={ref} type="button" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>+</button>
        {hover && <Tooltip anchorRef={ref} label="New chat" />}
      </>;
    }
    render(<IconWithTip />);
    const anchor = screen.getByRole('button');
    tap(anchor);
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.mouseLeave(anchor);
    fireEvent.pointerOver(anchor, { pointerType: 'mouse' });
    fireEvent.mouseEnter(anchor);
    expect(screen.getByRole('tooltip').textContent).toContain('New chat');
  });
});
