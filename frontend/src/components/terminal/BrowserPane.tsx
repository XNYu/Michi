import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserPaneItem } from '../../state/paneItems';
import { normalizeBrowserUrl } from '../../state/paneItems';
import { useChatActions } from '../../state/chatStore';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { getElectron, type BrowserSurfaceState } from '../../lib/electronBridge';

const EMPTY_STATE: BrowserSurfaceState = {
  surfaceId: '', url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
};

export default function BrowserPane({ item }: { item: BrowserPaneItem }) {
  const { closePane, focusPane, setFocusedNodeId, updatePaneItem } = useChatActions();
  const closePaneRef = useRef(closePane);
  closePaneRef.current = closePane;
  const shellStyle = usePaneShellStyle(item.id);
  const viewportRef = useRef<HTMLDivElement>(null);
  const nativeVisibleRef = useRef(true);
  const [address, setAddress] = useState(item.url);
  const [state, setState] = useState<BrowserSurfaceState>({ ...EMPTY_STATE, surfaceId: item.surfaceId, url: item.url });
  const electron = getElectron();

  const publishBounds = useCallback(() => {
    const element = viewportRef.current;
    if (!element || !electron?.browserSetBounds) return;
    const rect = element.getBoundingClientRect();
    const visible = nativeVisibleRef.current && document.visibilityState === 'visible'
      && rect.bottom > 0 && rect.right > 0
      && rect.top < window.innerHeight && rect.left < window.innerWidth;
    electron.browserSetBounds(item.surfaceId, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    }, visible);
  }, [electron, item.surfaceId]);

  useEffect(() => {
    if (!electron?.browserCreate) return;
    let disposed = false;
    let creationBoundsRaf = 0;
    const offState = electron.onBrowserState?.((next) => {
      if (next.surfaceId !== item.surfaceId) return;
      setState(next);
      if (next.url) setAddress(next.url);
      updatePaneItem(item.id, {
        ...(next.url ? { url: next.url } : {}),
        ...(next.title ? { title: next.title } : {}),
      });
    });
    const offFocus = electron.onBrowserFocus?.((surfaceId) => {
      if (surfaceId !== item.surfaceId) return;
      focusPane(item.id);
      setFocusedNodeId(null);
    });
    const offCloseRequest = electron.onBrowserCloseRequest?.((surfaceId) => {
      if (surfaceId === item.surfaceId) closePaneRef.current(item.id);
    });
    electron.browserCreate(item.surfaceId, item.projectId, item.url)
      .then((next) => {
        if (disposed) return;
        setState(next);
        if (next.url) setAddress(next.url);
        // Surface creation is asynchronous (and may include hidden theme
        // initialization), so bounds published during mount can arrive before
        // the main process has registered the surface. Republish the latest
        // painted rectangle once creation is complete.
        creationBoundsRaf = requestAnimationFrame(publishBounds);
      })
      .catch((error) => {
        if (disposed) return;
        setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : 'Unable to open browser' }));
      });
    return () => {
      disposed = true;
      cancelAnimationFrame(creationBoundsRaf);
      offState?.();
      offFocus?.();
      offCloseRequest?.();
      electron.browserSetBounds?.(item.surfaceId, { x: 0, y: 0, width: 1, height: 1 }, false);
    };
    // item.url changes as navigation events arrive; creation is keyed only by
    // the stable surface id so a redirect cannot recreate the WebContentsView.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [electron, focusPane, item.id, item.projectId, item.surfaceId, publishBounds, setFocusedNodeId, updatePaneItem]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element || !electron?.browserSetBounds) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(publishBounds);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    const events = ['resize', 'scroll', 'michi:dashboard-scroll', 'michi:caption-scroll'] as const;
    for (const event of events) window.addEventListener(event, schedule, { passive: true });
    document.addEventListener('visibilitychange', schedule);
    const onNativeVisibility = (event: Event) => {
      nativeVisibleRef.current = (event as CustomEvent<{ visible: boolean }>).detail.visible;
      schedule();
    };
    window.addEventListener('michi:native-surfaces-visible', onNativeVisibility as EventListener);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, schedule);
      document.removeEventListener('visibilitychange', schedule);
      window.removeEventListener('michi:native-surfaces-visible', onNativeVisibility as EventListener);
    };
  }, [electron, publishBounds]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizeBrowserUrl(address);
    if (!url) {
      setState((prev) => ({ ...prev, error: 'Enter a valid HTTP(S) address' }));
      return;
    }
    setAddress(url);
    void electron?.browserNavigate?.(item.surfaceId, url).catch((error) => {
      setState((prev) => ({ ...prev, error: error instanceof Error ? error.message : 'Navigation failed' }));
    });
  };

  const desktopAvailable = !!electron?.browserCreate;
  return (
    <div data-pane-id={item.id} data-pane-kind="browser" className="terminal-pane" onMouseDown={() => { focusPane(item.id); setFocusedNodeId(null); }} style={shellStyle}>
      <div style={{ height: 38, padding: '0 8px', display: 'flex', alignItems: 'center', gap: 4, borderBottom: '1px solid var(--term-line)', flexShrink: 0 }}>
        <button type="button" className="t-icon-btn" disabled={!state.canGoBack} onClick={() => electron?.browserBack?.(item.surfaceId)} aria-label="Back">‹</button>
        <button type="button" className="t-icon-btn" disabled={!state.canGoForward} onClick={() => electron?.browserForward?.(item.surfaceId)} aria-label="Forward">›</button>
        <button type="button" className="t-icon-btn" onClick={() => state.loading ? electron?.browserStop?.(item.surfaceId) : electron?.browserReload?.(item.surfaceId)} aria-label={state.loading ? 'Stop' : 'Reload'}>{state.loading ? '×' : '↻'}</button>
        <form onSubmit={navigate} style={{ flex: 1, minWidth: 0 }}>
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            aria-label="Browser address"
            spellCheck={false}
            style={{ width: '100%', height: 25, boxSizing: 'border-box', border: '1px solid var(--term-line)', borderRadius: 3, background: 'var(--term-alt)', color: 'var(--term-fg)', padding: '0 9px', fontFamily: 'var(--ui-font)', fontSize: 10.5, outline: 'none' }}
          />
        </form>
        <button type="button" className="t-icon-btn" onClick={() => { if (state.url) window.open(state.url, '_blank', 'noopener'); }} aria-label="Open in system browser">↗</button>
      </div>
      <div ref={viewportRef} style={{ flex: 1, minHeight: 0, position: 'relative', background: 'var(--term-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!desktopAvailable ? <div style={{ maxWidth: 280, padding: 20, textAlign: 'center', color: 'var(--term-muted)', fontSize: 11, lineHeight: 1.6 }}>Native browser surfaces are available in the Michi desktop app. Web deployments cannot bypass site iframe policies.</div> : null}
        {state.error ? <div style={{ position: 'absolute', inset: 0, padding: 20, background: 'var(--term-bg)', color: 'var(--term-danger)', fontSize: 11, zIndex: 1 }}>⚠ {state.error}</div> : null}
      </div>
    </div>
  );
}
