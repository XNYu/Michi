import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { activeTreeRootNodeId, chatLabel, shallowArrayEqual, useChatActions, useChatPanes, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { buildTree, type TreeNode } from '../../state/tree';
import { PopoverSurface } from '../ui/Popover';
import './mobile.css';

/** The accepted Touch study: a right-hand list of indented titles, not cards.
 * Branches in the current tree can reopen a closed pane. Non-chat panes remain
 * reachable below the tree, and merge/link edges never pull in another tree. */
export function MobilePaneSwitcher() {
  const { activeProject } = useChatProjects();
  const { openPanes, tabPanes, focusedPane, paneItems = {} } = useChatPanes();
  const { openPane, focusPane } = useChatActions();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const panes = tabPanes ?? openPanes;
  const aliveIds = useStructuralSelector(nodes => Object.keys(nodes).filter(key => nodes[key].projectId === activeProject?.id && !nodes[key].deletedAt), shallowArrayEqual);
  const rows = useMemo(() => {
    const root = activeProject && activeTreeRootNodeId(activeProject);
    const alive = new Set(aliveIds);
    const result: { id: string; depth: number }[] = [];
    const add = (node: TreeNode) => { result.push({ id: node.nodeId, depth: node.depth }); node.children.forEach(add); };
    if (root && alive.has(root)) add(buildTree(root, activeProject!.edges, key => alive.has(key)));
    for (const paneId of panes) if (paneItems[paneId]?.kind !== 'browser' && !result.some(row => row.id === paneId)) result.push({ id: paneId, depth: 0 });
    return result;
  }, [activeProject, aliveIds, panes, paneItems]);
  const titles = useStructuralSelector(nodes => rows.map(row => paneItems[row.id]?.title || nodes[row.id]?.title || chatLabel(nodes[row.id]) || 'Untitled'), shallowArrayEqual);
  const statuses = useStructuralSelector(nodes => rows.map(row => nodes[row.id]?.status === 'streaming' && !nodes[row.id]?.visibleResponseComplete ? 'streaming' : nodes[row.id]?.status === 'error' ? 'error' : 'idle'), shallowArrayEqual);
  const dismiss = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { setOpen(false); }, [activeProject?.id, activeProject?.activeTreeId]);
  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLButtonElement>('[aria-current="page"]') ?? panel.current?.querySelector('button'))?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key, true); };
  }, [open]);
  if (rows.length < 2) return null;
  return <>
    <button ref={trigger} type="button" className="mobile-pane-trigger t-icon-btn" aria-label="Switch pane" aria-expanded={open} aria-controls={id}
      onClick={() => setOpen(value => !value)}><svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M9 12h11M4 18h16" /></svg></button>
    {open && <PopoverSurface ref={panel} role="navigation" aria-label="Branches and panes" right={12} top={52}
      width="min(300px, calc(100vw - 24px))" maxHeight="calc(100dvh - 76px)" className="mobile-pane-list" glass>
      <div id={id} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>{rows.map((row, index) => <button type="button" key={row.id} className="mobile-pane-row"
        style={{ '--pane-depth': Math.min(row.depth, 10) } as React.CSSProperties}
        aria-current={focusedPane === row.id ? 'page' : undefined}
        onClick={() => { if (panes.includes(row.id)) focusPane(row.id); else openPane(row.id); dismiss(); }}>
        <span>{titles[index]}</span>
        {statuses[index] !== 'idle' && <i className="mobile-pane-status" data-status={statuses[index]} aria-label={statuses[index] === 'streaming' ? 'Working' : 'Error'} />}
      </button>)}</div>
    </PopoverSurface>}
  </>;
}
