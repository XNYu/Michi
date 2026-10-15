import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BrowserPaneItem } from '../../state/paneItems';
import { useChatActions } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import ResizeHandle from '../ResizeHandle';
import BrowserPane from './BrowserPane';
import PaneCaption from './PaneCaption';
import PaneErrorBoundary from './PaneErrorBoundary';

/** A normal pane pinned outside the scrolling strip; its caption lives in the topbar. */
export default function BrowserDock({ items, focusedPane }: { items: BrowserPaneItem[]; focusedPane: string | null }) {
  const { focusPane, closePane, setPaneWidth, reorderPane } = useChatActions();
  const { prefs } = usePrefs();
  const dockRef = useRef<HTMLDivElement>(null);
  const [captionHost, setCaptionHost] = useState<HTMLElement | null>(null);
  const [selection, setSelection] = useState(items.find(item => item.id === focusedPane)?.id ?? items[0]?.id);
  const previousFocus = useRef<string | null>(null);
  const focusedBrowser = items.find(item => item.id === focusedPane);
  const selected = items.find(item => item.id === selection) ?? items[0];
  useLayoutEffect(() => {
    if (focusedBrowser && previousFocus.current !== focusedPane) setSelection(focusedBrowser.id);
    previousFocus.current = focusedBrowser?.id ?? null;
  }, [focusedBrowser, focusedPane]);

  useLayoutEffect(() => {
    const dock = dockRef.current;
    const shell = dock?.closest<HTMLElement>('.terminal-shell');
    if (!dock || !shell) return;
    setCaptionHost(shell.querySelector<HTMLElement>('[data-browser-caption-host]'));
    const buttons = shell.querySelector<HTMLElement>('.terminal-topbar-right');
    const sync = () => {
      shell.style.setProperty('--browser-dock-width', `${dock.getBoundingClientRect().width}px`);
      shell.style.setProperty('--browser-caption-actions', `${buttons?.getBoundingClientRect().width ?? 0}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(dock);
    if (buttons) observer.observe(buttons);
    return () => {
      observer.disconnect();
      shell.style.removeProperty('--browser-dock-width');
      shell.style.removeProperty('--browser-caption-actions');
    };
  }, []);

  if (!selected) return null;
  const focused = focusedPane === selected.id || focusedPane === null;
  return <div ref={dockRef} data-browser-dock data-node-id={selected.id} style={{
    position: 'relative', display: 'flex', flexDirection: 'column', flexShrink: 0,
    width: selected.width === undefined ? '50%' : `calc(${selected.width}px + 2 * var(--term-dashboard-padding, 0px))`,
    maxWidth: '50%', boxSizing: 'border-box', padding: 'var(--term-dashboard-padding, 0px)',
    minWidth: 0, minHeight: 0, background: 'var(--term-bg)', overflow: 'hidden',
  }}>
    {captionHost && createPortal(<div data-browser-caption style={{
      display: 'flex', alignItems: 'center', minWidth: 0, flex: 1,
      paddingLeft: 12, paddingRight: 'var(--browser-caption-actions, 0px)',
      // No focus dim: the native page cannot be dimmed, so dimming only its
      // caption and chrome would make them read as a darker frame.
      background: 'var(--term-pane-bg)', color: 'var(--term-fg)',
      borderRight: prefs.paneRules ? '1px solid var(--term-line)' : 'none',
    }}>
      {items.length > 1 && <select aria-label="Browser pages" value={selected.id}
        onChange={event => { setSelection(event.target.value); focusPane(event.target.value); }}
        style={{ width: 30, flexShrink: 0, background: 'var(--term-pane-bg)', color: 'var(--term-mid)', border: 0, fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {items.map((item, index) => <option key={item.id} value={item.id}>{index + 1} · {item.title || 'Browser'}</option>)}
      </select>}
      <PaneCaption nodeId={selected.id} title={selected.title || 'Browser'} kind="browser"
        focused={focused} streaming={false} error={false} onFocus={focusPane} onClose={closePane}
        onCloseOthers={id => { for (const item of items) if (item.id !== id) closePane(item.id); }}
        canCloseOthers={items.length > 1} onReorder={reorderPane} />
    </div>, captionHost)}
    {items.map(item => <div key={item.id} hidden={item.id !== selected.id} style={{
      display: item.id === selected.id ? 'flex' : 'none', flexDirection: 'column',
      flex: 1, minHeight: 0, minWidth: 0,
    }}>
      <PaneErrorBoundary paneId={item.id}><BrowserPane item={item} active={item.id === selected.id} /></PaneErrorBoundary>
    </div>)}
    <ResizeHandle paneRef={dockRef} side="left"
      onResize={width => {
        const padding = parseFloat(getComputedStyle(dockRef.current!).paddingLeft) || 0;
        const available = dockRef.current?.parentElement?.clientWidth ?? width * 2;
        setPaneWidth(selected.id, Math.max(1, Math.min(width, available / 2) - padding * 2));
      }}
      onReset={() => setPaneWidth(selected.id, undefined)} />
  </div>;
}
