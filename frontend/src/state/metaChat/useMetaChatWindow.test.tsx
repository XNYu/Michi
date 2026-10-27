import { StrictMode } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { METACHAT_STORAGE_KEY } from './metaChatWindowModel';
import { useMetaChatWindow, type MetaChatWindowController } from './useMetaChatWindow';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const stored = () => JSON.parse(localStorage.getItem(METACHAT_STORAGE_KEY) ?? 'null');

describe('useMetaChatWindow', () => {
  it('starts floating with the default box', () => {
    const { result } = renderHook(() => useMetaChatWindow());
    expect(result.current.state).toEqual({ form: 'float', minimized: false, rect: null, dockRatio: 50 });
  });

  it('restores the form it was minimized from', () => {
    const { result } = renderHook(() => useMetaChatWindow());
    act(() => result.current.dock());
    act(() => result.current.minimize());
    expect(result.current.state).toMatchObject({ form: 'dock', minimized: true });
    act(() => result.current.toggleMinimized());
    expect(result.current.state).toMatchObject({ form: 'dock', minimized: false });
    act(() => result.current.float());
    act(() => result.current.toggleMinimized());
    act(() => result.current.toggleMinimized());
    expect(result.current.state).toMatchObject({ form: 'float', minimized: false });
  });

  it('restores the previous form and placement after full screen and minimization', () => {
    const { result } = renderHook(() => useMetaChatWindow());
    act(() => result.current.setRect({ x: 200, y: 80, w: 450, h: 600 }));
    act(() => result.current.dock());
    act(() => result.current.setDockRatio(61));
    const previous = result.current.state;
    act(() => result.current.toggleFullscreen());
    expect(result.current.fullscreen).toBe(true);
    act(() => result.current.minimize());
    act(() => result.current.restore());
    expect(result.current.fullscreen).toBe(true);
    act(() => result.current.toggleFullscreen());
    expect(result.current.fullscreen).toBe(false);
    expect(result.current.state).toEqual(previous);
    act(() => result.current.toggleFullscreen());
    act(() => result.current.float());
    expect(result.current.fullscreen).toBe(false);
    expect(result.current.state.rect).toEqual(previous.rect);
  });

  it('round-trips form, box and ratio through storage', () => {
    const first = renderHook(() => useMetaChatWindow());
    act(() => first.result.current.setRect({ x: 300, y: 80, w: 540, h: 660 }));
    act(() => first.result.current.setDockRatio(64));
    act(() => first.result.current.dock());
    act(() => first.result.current.minimize());
    first.unmount();
    expect(stored()).toEqual({ form: 'dock', minimized: true, rect: { x: 300, y: 80, w: 540, h: 660 }, dockRatio: 64 });

    const second = renderHook(() => useMetaChatWindow());
    expect(second.result.current.state).toEqual(stored());
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem(METACHAT_STORAGE_KEY, JSON.stringify({ form: 42, rect: 'big', dockRatio: 99 }));
    const { result } = renderHook(() => useMetaChatWindow());
    expect(result.current.state).toEqual({ form: 'float', minimized: false, rect: null, dockRatio: 70 });
  });

  it('does not write on StrictMode mount or unmount', () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    let controller: MetaChatWindowController | null = null;
    function Probe() {
      controller = useMetaChatWindow();
      return null;
    }
    const view = render(<StrictMode><Probe /></StrictMode>);
    view.rerender(<StrictMode><Probe /></StrictMode>);
    view.unmount();
    expect(setItem).not.toHaveBeenCalled();
    expect(controller).not.toBeNull();
    expect(localStorage.getItem(METACHAT_STORAGE_KEY)).toBeNull();
  });

  it('opens and asks for focus from focusInput', () => {
    const { result } = renderHook(() => useMetaChatWindow());
    act(() => result.current.minimize());
    const token = result.current.focusToken;
    act(() => result.current.focusInput());
    expect(result.current.state.minimized).toBe(false);
    expect(result.current.focusToken).toBe(token + 1);
  });

  it('shows the window floating without taking focus', () => {
    const { result } = renderHook(() => useMetaChatWindow());
    act(() => result.current.dock());
    act(() => result.current.minimize());
    const token = result.current.focusToken;
    act(() => result.current.showFloating());
    expect(result.current.state).toMatchObject({ form: 'float', minimized: false });
    expect(result.current.focusToken).toBe(token);
  });

  it('keeps state in memory when storage is null', () => {
    const setItem = vi.spyOn(localStorage, 'setItem');
    const { result } = renderHook(() => useMetaChatWindow({ storage: null }));
    act(() => result.current.dock());
    expect(result.current.state.form).toBe('dock');
    expect(setItem).not.toHaveBeenCalled();
  });

  describe('first open', () => {
    it('is the first open only while nothing is stored, and never without storage', () => {
      expect(renderHook(() => useMetaChatWindow()).result.current.firstOpen).toBe(true);
      expect(renderHook(() => useMetaChatWindow({ storage: null })).result.current.firstOpen).toBe(false);
      localStorage.setItem(METACHAT_STORAGE_KEY, JSON.stringify({ form: 'float' }));
      expect(renderHook(() => useMetaChatWindow()).result.current.firstOpen).toBe(false);
    });

    it('applies the first placement once, in memory, without writing storage', () => {
      const setItem = vi.spyOn(localStorage, 'setItem');
      const { result } = renderHook(() => useMetaChatWindow());
      act(() => result.current.placeFirstOpen({ minimized: true, rect: null }));
      expect(result.current.state).toMatchObject({ form: 'float', minimized: true, rect: null });
      expect(result.current.firstOpen).toBe(false);
      act(() => result.current.placeFirstOpen({ minimized: false, rect: { x: 1, y: 2, w: 330, h: 520 } }));
      expect(result.current.state).toMatchObject({ minimized: true, rect: null });
      expect(setItem).not.toHaveBeenCalled();
      // The user's own action is what gets stored.
      act(() => result.current.restore());
      expect(stored()).toMatchObject({ form: 'float', minimized: false });
    });

    it('keeps a narrower box until the user moves it, and never places a window the user already touched', () => {
      const { result } = renderHook(() => useMetaChatWindow());
      act(() => result.current.placeFirstOpen({ minimized: false, rect: { x: 1152, y: 262, w: 330, h: 520 } }));
      expect(result.current.state.rect).toEqual({ x: 1152, y: 262, w: 330, h: 520 });
      localStorage.clear();

      const other = renderHook(() => useMetaChatWindow());
      act(() => other.result.current.dock());
      expect(other.result.current.firstOpen).toBe(false);
      act(() => other.result.current.placeFirstOpen({ minimized: true, rect: null }));
      expect(other.result.current.state).toMatchObject({ form: 'dock', minimized: false });
    });
  });
});
