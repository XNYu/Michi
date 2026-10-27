import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbPopover } from './DbPopover';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('DbPopover positioning', () => {
  it('remeasures on scroll, viewport resize and observed content growth without dismissing', () => {
    let observeCallback: () => void = () => {};
    const disconnect = vi.fn();
    const observed: Element[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { observeCallback = callback; }
      observe(target: Element) { observed.push(target); }
      disconnect = disconnect;
    });
    const view = render(<button>Properties</button>);
    const anchor = screen.getByRole('button');
    let top = 100;
    let height = 100;
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => ({ left: 100, right: 140, top, bottom: top + 20, width: 40, height: 20, x: 100, y: top, toJSON() {} }));
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
      return this.classList.contains('michi-db-pop') ? { left: 0, right: 240, top: 0, bottom: height, width: 240, height, x: 0, y: 0, toJSON() {} } : original.call(this);
    });
    const close = vi.fn();
    view.rerender(<><button>Properties</button><DbPopover anchor={anchor} label="Properties" onClose={close}><button>Add rule</button></DbPopover></>);
    const panel = screen.getByRole('dialog');
    expect(panel.style.top).toBe('124px');
    expect(observed).toEqual([anchor, panel]);
    top = 200;
    fireEvent.scroll(window);
    expect(panel.style.top).toBe('224px');
    top = 500;
    fireEvent.resize(window);
    expect(panel.style.top).toBe('524px');
    height = 400;
    act(() => observeCallback());
    expect(panel.style.top).toBe('96px');
    expect(close).not.toHaveBeenCalled();
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
