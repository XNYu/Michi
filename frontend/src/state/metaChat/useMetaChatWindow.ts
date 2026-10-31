import { useCallback, useMemo, useRef, useState } from 'react';
import {
  clampDockRatio,
  METACHAT_STORAGE_KEY,
  readStoredState,
  writeStoredState,
  type FirstOpenPlacement,
  type MetaChatWindowState,
  type Rect,
} from './metaChatWindowModel';

export interface MetaChatWindowController {
  state: MetaChatWindowState;
  /** Bumps whenever something asks for the input to take focus. */
  focusToken: number;
  fullscreen: boolean;
  toggleFullscreen: () => void;
  setRect: (rect: Rect) => void;
  setDockRatio: (ratio: number) => void;
  dock: () => void;
  float: () => void;
  minimize: () => void;
  /** Opens the window if it is minimized and puts the cursor in its input, except on a touch screen: there a tap on the composer does. */
  restore: () => void;
  toggleMinimized: () => void;
  /** Opens the window if it is minimized and puts the cursor in its input, on a touch screen too: something waits there to be typed. */
  focusInput: () => void;
  /** Shows the window floating without taking focus (the first run opening it for the user). */
  showFloating: () => void;
  /** True until the window's first placement: nothing stored yet and nothing done to it this session. */
  firstOpen: boolean;
  /** Applies the first placement once, in memory only: the user has not placed the window yet. */
  placeFirstOpen: (placement: FirstOpenPlacement) => void;
}

export interface UseMetaChatWindowOptions {
  /** Defaults to window.localStorage; null keeps the state in memory only. */
  storage?: Storage | null;
  storageKey?: string;
  /** The state before anything is stored (the Scheduled window starts minimized to its button). */
  initialState?: Partial<MetaChatWindowState>;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Touch is the main input (a phone or tablet): focusing a text field raises the on-screen keyboard. */
function touchScreen(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
}

/** No stored window yet: this browser has never had the window placed. Without storage there is no first time to detect. */
function nothingStored(storage: Storage | null, key: string): boolean {
  try {
    return storage !== null && storage.getItem(key) === null;
  } catch {
    return false;
  }
}

/**
 * Form, box and divider ratio of the Meta agent window. Writes happen in the
 * actions themselves, never from an effect, so mounting or unmounting the host
 * (StrictMode included) leaves storage untouched.
 */
export function useMetaChatWindow(options: UseMetaChatWindowOptions = {}): MetaChatWindowController {
  const storageRef = useRef<Storage | null>(options.storage === undefined ? defaultStorage() : options.storage);
  const keyRef = useRef(options.storageKey ?? METACHAT_STORAGE_KEY);
  const [state, setState] = useState<MetaChatWindowState>(() => (
    options.initialState && (storageRef.current === null || nothingStored(storageRef.current, keyRef.current))
      ? { ...readStoredState(null), ...options.initialState }
      : readStoredState(storageRef.current, keyRef.current)
  ));
  const [fullscreen, setFullscreen] = useState(false);
  const [focusToken, setFocusToken] = useState(0);
  const stateRef = useRef(state);
  const [firstOpen, setFirstOpen] = useState(() => nothingStored(storageRef.current, keyRef.current));
  const firstOpenRef = useRef(firstOpen);

  const endFirstOpen = useCallback(() => {
    if (!firstOpenRef.current) return;
    firstOpenRef.current = false;
    setFirstOpen(false);
  }, []);

  const commit = useCallback((change: (prev: MetaChatWindowState) => MetaChatWindowState) => {
    endFirstOpen();
    const prev = stateRef.current;
    const next = change(prev);
    if (
      next.form === prev.form &&
      next.minimized === prev.minimized &&
      next.dockRatio === prev.dockRatio &&
      next.rect === prev.rect
    ) return;
    stateRef.current = next;
    setState(next);
    writeStoredState(storageRef.current, next, keyRef.current);
  }, [endFirstOpen]);

  const placeFirstOpen = useCallback((placement: FirstOpenPlacement) => {
    if (!firstOpenRef.current) return;
    endFirstOpen();
    if (!placement.minimized && !placement.rect) return;
    const prev = stateRef.current;
    const next = { ...prev, minimized: prev.minimized || placement.minimized, rect: placement.rect ?? prev.rect };
    stateRef.current = next;
    setState(next);
  }, [endFirstOpen]);

  const requestFocus = useCallback(() => setFocusToken((n) => n + 1), []);
  // Showing the window takes focus, except on a touch screen: the keyboard would come up over the conversation.
  const focusOnShow = useCallback(() => { if (!touchScreen()) requestFocus(); }, [requestFocus]);

  const setRect = useCallback((rect: Rect) => commit((s) => (
    s.rect && s.rect.x === rect.x && s.rect.y === rect.y && s.rect.w === rect.w && s.rect.h === rect.h
      ? s
      : { ...s, rect: { ...rect } }
  )), [commit]);
  const setDockRatio = useCallback((ratio: number) => commit((s) => ({ ...s, dockRatio: clampDockRatio(ratio) })), [commit]);
  const dock = useCallback(() => {
    setFullscreen(false);
    commit((s) => ({ ...s, form: 'dock', minimized: false }));
    focusOnShow();
  }, [commit, focusOnShow]);
  const float = useCallback(() => {
    setFullscreen(false);
    commit((s) => ({ ...s, form: 'float', minimized: false }));
    focusOnShow();
  }, [commit, focusOnShow]);
  const minimize = useCallback(() => commit((s) => ({ ...s, minimized: true })), [commit]);
  const restore = useCallback(() => {
    commit((s) => ({ ...s, minimized: false }));
    focusOnShow();
  }, [commit, focusOnShow]);
  const focusInput = useCallback(() => {
    commit((s) => ({ ...s, minimized: false }));
    requestFocus();
  }, [commit, requestFocus]);
  const showFloating = useCallback(() => { setFullscreen(false); commit((s) => ({ ...s, form: 'float', minimized: false })); }, [commit]);
  const toggleFullscreen = useCallback(() => {
    setFullscreen(value => !value);
    restore();
  }, [restore]);
  const toggleMinimized = useCallback(() => {
    if (stateRef.current.minimized) restore();
    else minimize();
  }, [minimize, restore]);

  return useMemo(() => ({
    state, focusToken, fullscreen, toggleFullscreen, setRect, setDockRatio, dock, float, minimize, restore, toggleMinimized, focusInput, showFloating, firstOpen, placeFirstOpen,
  }), [state, focusToken, fullscreen, toggleFullscreen, setRect, setDockRatio, dock, float, minimize, restore, toggleMinimized, focusInput, showFloating, firstOpen, placeFirstOpen]);
}
