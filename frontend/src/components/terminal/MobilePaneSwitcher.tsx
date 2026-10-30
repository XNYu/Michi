import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { activeTreeRootNodeId, chatLabel, shallowArrayEqual, useChatActions, useChatPanes, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { buildTree, type TreeNode } from '../../state/tree';
import { PopoverSurface } from '../ui/Popover';
import { branchMotionAllowed, branchMotionReduced, isFreshBranch, playBranchFlight, pulseBranchTarget, type BranchFlightOrigin } from './branchMotion';
import { BranchIcon } from './icons';
import './mobile.css';

/** A tap this recent is the gesture that started the branch. */
const FLIGHT_TAP_MS = 2000;

/** The accepted Touch study: a right-hand list of indented titles, not cards.
 * Branches in the current tree can reopen a closed pane, and open panes carry
 * a close button: phones have no tab strip or caption cells to close from.
 * Non-chat panes remain reachable below the tree, and merge/link edges never
 * pull in another tree. */
export function MobilePaneSwitcher() {
  const { activeProject } = useChatProjects();
  const { openPanes, tabPanes, focusedPane, paneItems = {} } = useChatPanes();
  const { openPane, focusPane, closePane } = useChatActions();
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

  // A branch started in the background changes nothing on screen, so show it
  // leaving the tap for the switcher. Foreground branches push in (Dashboard).
  const [flight, setFlight] = useState<{ id: string; from: BranchFlightOrigin } | null>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const lastTap = useRef<BranchFlightOrigin & { at: number } | null>(null);
  useEffect(() => {
    const remember = (event: PointerEvent) => { lastTap.current = { x: event.clientX, y: event.clientY, at: performance.now() }; };
    document.addEventListener('pointerdown', remember, true);
    return () => document.removeEventListener('pointerdown', remember, true);
  }, []);
  const knownRows = useRef({ tree: activeProject?.activeTreeId, ids: new Set(rows.map(row => row.id)) });
  useLayoutEffect(() => {
    const previous = knownRows.current;
    knownRows.current = { tree: activeProject?.activeTreeId, ids: new Set(rows.map(row => row.id)) };
    if (previous.tree !== activeProject?.activeTreeId) return;
    const arrived = rows.find(row => !previous.ids.has(row.id) && row.id !== focusedPane && isFreshBranch(activeProject?.edges, row.id));
    if (!arrived || !branchMotionAllowed()) return;
    if (branchMotionReduced()) {
      if (trigger.current) pulseBranchTarget(trigger.current);
      return;
    }
    const tap = lastTap.current;
    const from = tap && performance.now() - tap.at < FLIGHT_TAP_MS ? tap : { x: window.innerWidth / 2, y: window.innerHeight - 72 };
    setFlight({ id: arrived.id, from: { x: from.x, y: from.y } });
  }, [rows, focusedPane, activeProject?.activeTreeId, activeProject?.edges]);
  useLayoutEffect(() => {
    if (!flight || !chip.current || !trigger.current) return;
    return playBranchFlight(chip.current, trigger.current, flight.from, () => setFlight(null));
  }, [flight]);

  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLButtonElement>('.mobile-pane-row[aria-current="page"]') ?? panel.current?.querySelector<HTMLButtonElement>('.mobile-pane-row'))?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('.mobile-pane-row') ?? []);
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
      <div id={id} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}>{rows.map((row, index) => {
        const isOpen = panes.includes(row.id);
        return <div key={row.id} className="mobile-pane-item" data-current={focusedPane === row.id ? '' : undefined}>
          <button type="button" className="mobile-pane-row"
            style={{ '--pane-depth': Math.min(row.depth, 10) } as React.CSSProperties}
            aria-current={focusedPane === row.id ? 'page' : undefined}
            onClick={() => { if (isOpen) focusPane(row.id); else openPane(row.id); dismiss(); }}>
            <span>{titles[index]}</span>
            {statuses[index] !== 'idle' && <i className="mobile-pane-status" data-status={statuses[index]} aria-label={statuses[index] === 'streaming' ? 'Working' : 'Error'} />}
          </button>
          {/* The list stays open so several panes can be closed in a row; a
              tree branch stays listed and can be reopened. */}
          {isOpen && <button type="button" className="mobile-pane-close" aria-label={`Close ${titles[index]}`}
            onClick={event => { (event.currentTarget.previousElementSibling as HTMLButtonElement | null)?.focus({ preventScroll: true }); closePane(row.id); }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>}
        </div>;
      })}</div>
    </PopoverSurface>}
    {flight && createPortal(<span ref={chip} key={flight.id} className="mobile-branch-flight" aria-hidden="true"><BranchIcon size={16} /></span>, document.body)}
  </>;
}
