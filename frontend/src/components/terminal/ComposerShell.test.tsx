import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComposerShell, type ComposerShellHandle } from './ComposerShell';

describe('ComposerShell', () => {
  it('forwards drag handlers to the outer div', () => {
    let dropped = false;
    const { container } = render(
      <ComposerShell
        input={<textarea defaultValue="" />}
        onDrop={() => {
          dropped = true;
        }}
      />,
    );
    const root = container.querySelector('.terminal-composer') as HTMLElement;
    fireEvent.drop(root);
    expect(dropped).toBe(true);
  });
});

const wideWidth = window.innerWidth;
const setWidth = (value: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value });
afterEach(() => setWidth(wideWidth));

function Shell({ ref, ...props }: Partial<React.ComponentProps<typeof ComposerShell>> & { ref?: React.Ref<ComposerShellHandle> }) {
  return (
    <>
      <ComposerShell
        ref={ref}
        collapsible
        input={<div role="textbox" aria-label="Message" tabIndex={0} />}
        toolbarLeft={<>
          <span className="t-toolbar-chip composer-attach">+</span>
          <button type="button" className="t-toolbar-chip" aria-haspopup="menu">agent</button>
        </>}
        toolbarRight={<button type="button" className="t-action-btn">Send</button>}
        {...props}
      />
      <button type="button">elsewhere</button>
    </>
  );
}
const collapsed = () => document.querySelector('.terminal-composer')!.hasAttribute('data-collapsed');
const caretRow = () => document.querySelector('.terminal-composer__input') as HTMLElement;

describe('ComposerShell on a phone', () => {
  it('rests as one row, opens when engaged and settles again on a tap elsewhere', () => {
    setWidth(390);
    render(<Shell collapsedHint="Reply…" />);
    expect(collapsed()).toBe(true);
    expect(screen.getByText('Reply…')).toBeTruthy();
    act(() => screen.getByRole('textbox').focus());
    expect(collapsed()).toBe(false);
    fireEvent.pointerDown(screen.getByText('elsewhere'));
    expect(collapsed()).toBe(true);
  });

  it('focuses the field in the same tap that opens it', () => {
    setWidth(390);
    render(<Shell collapsedHint="Reply…" />);
    // Opening on pointerdown moved the field before Safari's click landed.
    fireEvent.pointerDown(caretRow());
    expect(collapsed()).toBe(true);
    fireEvent.click(caretRow());
    expect(collapsed()).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  it('opens without focusing the field when a control is tapped', () => {
    setWidth(390);
    render(<Shell collapsedHint="Reply…" />);
    fireEvent.click(screen.getByText('+'));
    expect(collapsed()).toBe(false);
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });

  it('keeps the field focused when + or send is pressed, but not a menu trigger', () => {
    setWidth(390);
    render(<Shell collapsedHint="Reply…" />);
    act(() => screen.getByRole('textbox').focus());
    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.mouseDown(screen.getByText('+'))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText('Send'))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByText('agent'))).toBe(true);
    act(() => screen.getByRole('textbox').blur());
    expect(fireEvent.mouseDown(screen.getByText('+'))).toBe(true);
  });

  it('shows the hint as the open field\'s placeholder until text or an IME composition arrives', () => {
    setWidth(390);
    const { rerender } = render(<Shell collapsedHint="Reply…" />);
    act(() => screen.getByRole('textbox').focus());
    expect(screen.getByText('Reply…')).toBeTruthy();
    expect(document.querySelector('.terminal-composer__prompt')).toBeNull();
    fireEvent.compositionStart(screen.getByRole('textbox'));
    expect(screen.queryByText('Reply…')).toBeNull();
    fireEvent.compositionEnd(screen.getByRole('textbox'));
    expect(screen.getByText('Reply…')).toBeTruthy();
    rerender(<Shell collapsedHint="Reply…" hasContent />);
    expect(screen.queryByText('Reply…')).toBeNull();
  });

  it('stays open while it holds a draft, a menu or pre-blocks', () => {
    setWidth(390);
    const { rerender } = render(<Shell hasContent />);
    expect(collapsed()).toBe(false);
    rerender(<Shell holdOpen />);
    expect(collapsed()).toBe(false);
    rerender(<Shell preBlocks={<div>Queued: ship it</div>} />);
    expect(collapsed()).toBe(false);
    rerender(<Shell preBlocks={<>{null}</>} />);
    expect(collapsed()).toBe(true);
  });

  it('settles after a send: the field lets go and the composer rests as one row', () => {
    setWidth(390);
    const handle = React.createRef<ComposerShellHandle>();
    render(<Shell ref={handle} collapsedHint="Reply…" />);
    act(() => screen.getByRole('textbox').focus());
    expect(collapsed()).toBe(false);
    act(() => handle.current!.settle());
    expect(collapsed()).toBe(true);
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
  });

  it('leaves a desktop composer and its focus alone on settle', () => {
    setWidth(1200);
    const handle = React.createRef<ComposerShellHandle>();
    render(<Shell ref={handle} />);
    act(() => screen.getByRole('textbox').focus());
    act(() => handle.current!.settle());
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });

  describe('when the keyboard goes down', () => {
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0, scale: 1 });
    const keyboard = (inset: number) => act(() => {
      viewport.height = window.innerHeight - inset;
      viewport.dispatchEvent(new Event('resize'));
    });
    beforeEach(() => {
      viewport.height = window.innerHeight;
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    });
    afterEach(() => { delete (window as { visualViewport?: unknown }).visualViewport; });

    it('rests as one row even with a draft or pre-blocks, and lets go of the field', () => {
      setWidth(390);
      render(<Shell hasContent preBlocks={<div>Queued: ship it</div>} />);
      expect(collapsed()).toBe(false);
      act(() => screen.getByRole('textbox').focus());
      keyboard(300);
      expect(collapsed()).toBe(false);
      // Android's back key: the keyboard leaves while the field keeps focus.
      keyboard(0);
      expect(collapsed()).toBe(true);
      expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
      // The next engagement opens it again.
      act(() => screen.getByRole('textbox').focus());
      expect(collapsed()).toBe(false);
    });

    it('keeps a chip in place while its menu is open, then rests', () => {
      setWidth(390);
      const { rerender } = render(<Shell hasContent />);
      act(() => screen.getByRole('textbox').focus());
      keyboard(300);
      rerender(<Shell hasContent holdOpen />);
      keyboard(0);
      expect(collapsed()).toBe(false);
      rerender(<Shell hasContent />);
      expect(collapsed()).toBe(true);
    });

    it('ignores a keyboard raised for another input', () => {
      setWidth(390);
      render(<Shell hasContent />);
      keyboard(300);
      keyboard(0);
      expect(collapsed()).toBe(false);
    });
  });

  it('keeps the full composer in a wide window and where it is not collapsible', () => {
    setWidth(1200);
    const { unmount } = render(<Shell collapsedHint="Reply…" />);
    expect(collapsed()).toBe(false);
    expect(screen.queryByText('Reply…')).toBeNull();
    act(() => screen.getByRole('textbox').focus());
    expect(fireEvent.mouseDown(screen.getByText('+'))).toBe(true);
    unmount();
    setWidth(390);
    render(<Shell collapsible={false} />);
    expect(collapsed()).toBe(false);
  });
});

describe('ComposerShell height after a desktop send', () => {
  type Listener = () => void;
  interface FakeAnimation { target: Element; keyframes: Keyframe[]; finish: () => void; cancel: () => void }
  let animations: FakeAnimation[] = [];
  let observers: { callback: () => void; disconnected: boolean }[] = [];
  const realObserver = globalThis.ResizeObserver;
  let height = 120;

  beforeEach(() => {
    setWidth(1200);
    animations = [];
    observers = [];
    height = 120;
    globalThis.ResizeObserver = class {
      private entry: { callback: () => void; disconnected: boolean };
      constructor(callback: () => void) {
        this.entry = { callback, disconnected: false };
        observers.push(this.entry);
      }
      observe() {}
      unobserve() {}
      disconnect() { this.entry.disconnected = true; }
    } as unknown as typeof ResizeObserver;
    Element.prototype.animate = function animate(this: Element, keyframes: Keyframe[]) {
      const listeners: Record<string, Listener> = {};
      const animation = {
        target: this,
        keyframes,
        addEventListener: (type: string, listener: Listener) => { listeners[type] = listener; },
        finish: () => listeners.finish?.(),
        cancel: () => listeners.cancel?.(),
      };
      animations.push(animation);
      return animation as unknown as Animation;
    } as unknown as Element['animate'];
  });
  afterEach(() => {
    globalThis.ResizeObserver = realObserver;
    delete (Element.prototype as { animate?: unknown }).animate;
    delete document.documentElement.dataset.reduceMotion;
  });

  let preBlocks: React.ReactNode = undefined;
  let preHeight = 0;
  beforeEach(() => { preBlocks = undefined; preHeight = 0; });

  // The composer's bottom edge stays at 500; its top follows `height`.
  const mount = () => {
    const handle = React.createRef<ComposerShellHandle>();
    const view = render(<Shell ref={handle} position="absolute" preBlocks={preBlocks} />);
    const root = document.querySelector('.terminal-composer') as HTMLElement;
    const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 300, width: 300, x: 0, y: top }) as DOMRect;
    root.getBoundingClientRect = () => rect(500 - height, 500);
    const pre = root.querySelector<HTMLElement>('.composer-pre-blocks-scroll');
    if (pre) pre.getBoundingClientRect = () => rect(500 - height + 1, 500 - height + 1 + preHeight);
    caretRow().getBoundingClientRect = () => rect(500 - height + 1 + preHeight, 500 - 40);
    const rerender = (next: React.ReactNode) => view.rerender(<Shell ref={handle} position="absolute" preBlocks={next} />);
    return { handle, root, pre, rerender, frame: root.querySelector('.terminal-composer__morph') as HTMLElement };
  };
  const resize = () => act(() => { for (const o of observers) if (!o.disconnected) o.callback(); });

  it('settles the frame and the caret row from the old height once the emptied field lands', () => {
    const { handle, root, frame } = mount();
    act(() => handle.current!.settle());
    expect(observers).toHaveLength(1);
    resize(); // the observer's first report: nothing has changed yet
    expect(animations).toHaveLength(0);
    height = 60;
    resize();
    const [frameAnimation, caretAnimation] = animations;
    expect(frameAnimation.target).toBe(frame);
    const border = -parseFloat(frame.style.left) || 0;
    expect(frameAnimation.keyframes).toEqual([{ top: `${60 - 120 - border}px` }, { top: `${-border}px` }]);
    expect(caretAnimation.target).toBe(caretRow());
    expect(caretAnimation.keyframes).toEqual([{ transform: 'translateY(-60px)' }, { transform: 'none' }]);
    expect(root.hasAttribute('data-morphing')).toBe(true);
    act(() => frameAnimation.finish());
    expect(root.hasAttribute('data-morphing')).toBe(false);
    expect(observers[0].disconnected).toBe(true);
  });

  it('never animates the card while typing, only after a send', () => {
    mount();
    height = 60;
    resize();
    expect(observers).toHaveLength(0);
    expect(animations).toHaveLength(0);
  });

  it('lets growth after a send through at once', () => {
    const { handle, root } = mount();
    act(() => handle.current!.settle());
    height = 180;
    resize();
    expect(animations).toHaveLength(0);
    expect(root.hasAttribute('data-morphing')).toBe(false);
    expect(observers[0].disconnected).toBe(true);
  });

  it('ends a running settle at once when the field changes again', () => {
    const { handle, root } = mount();
    act(() => handle.current!.settle());
    height = 60;
    resize();
    expect(root.hasAttribute('data-morphing')).toBe(true);
    height = 80;
    resize();
    expect(root.hasAttribute('data-morphing')).toBe(false);
    expect(observers[0].disconnected).toBe(true);
  });

  it('snaps under reduced motion', () => {
    document.documentElement.dataset.reduceMotion = 'on';
    const { handle } = mount();
    act(() => handle.current!.settle());
    expect(observers).toHaveLength(0);
  });

  it('slides standing pre-blocks down with the caret row', () => {
    preBlocks = <div>Quote: keep this</div>;
    preHeight = 30;
    const { handle, pre } = mount();
    act(() => handle.current!.settle());
    height = 60;
    resize();
    expect(animations.map((a) => a.target)).toEqual([expect.anything(), pre, caretRow()]);
    for (const slide of animations.slice(1)) {
      expect(slide.keyframes).toEqual([{ transform: 'translateY(-60px)' }, { transform: 'none' }]);
    }
  });

  it('snaps when a queued message lands with the emptied field (Send next)', () => {
    preBlocks = <div>Queued: first</div>;
    preHeight = 30;
    const { handle, root, rerender } = mount();
    act(() => handle.current!.settle());
    // Same commit: the field empties and the queued message appears.
    rerender(<><div>Queued: first</div><div>Queued: second</div></>);
    height = 90;
    resize();
    expect(animations).toHaveLength(0);
    expect(root.hasAttribute('data-morphing')).toBe(false);
    expect(observers[0].disconnected).toBe(true);
  });

  it('ends a running settle before the phone layout takes the frame', () => {
    const { handle, root } = mount();
    act(() => handle.current!.settle());
    height = 60;
    resize();
    expect(root.hasAttribute('data-morphing')).toBe(true);
    act(() => {
      setWidth(390);
      window.dispatchEvent(new Event('resize'));
    });
    expect(observers[0].disconnected).toBe(true);
    expect(root.hasAttribute('data-morphing')).toBe(false);
  });
});
