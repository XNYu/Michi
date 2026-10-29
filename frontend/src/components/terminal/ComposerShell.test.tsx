import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
