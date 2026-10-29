import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { PageDto, PageEditOp } from 'michi-shared';
import type { ApplyResult } from '../content/page/BlockFrame';

interface Drop { after: string | null; left: number; top: number; width: number }

/** Pointer sorting across a page's rendered segments, saved with the revision picked up. */
export function usePageBlockDrag(page: PageDto, host: RefObject<HTMLDivElement | null>, onEdit: (ops: PageEditOp[], revision: number) => Promise<ApplyResult>, readOnly: boolean) {
  const latest = useRef({ page, onEdit, readOnly });
  latest.current = { page, onEdit, readOnly };
  const cleanup = useRef<(() => void) | null>(null);
  const dragged = useRef(false);
  const pending = useRef(false);
  const [moving, setMoving] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => cleanup.current?.(), [page.id, readOnly]);

  const dragStart = useCallback((id: string, event: ReactPointerEvent) => {
    cleanup.current?.();
    dragged.current = false;
    const current = latest.current;
    const block = current.page.blocks.find(item => item.id === id);
    const hostElement = host.current;
    if (current.readOnly || pending.current || !block || !hostElement) return;
    const revision = current.page.revision;
    const pageId = current.page.id;
    const workspaceId = current.page.workspaceId;
    const handle = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const origin = { x: event.clientX, y: event.clientY };
    let point = origin;
    let active = false;
    let target: Drop | null = null;
    let frame = 0;
    const scope = hostElement.closest('.pane-entry-surface, main') ?? hostElement;
    const frames = () => [scope as HTMLElement, ...Array.from(scope.querySelectorAll<HTMLElement>('[data-native-page-id]'))]
      .filter(doc => doc.dataset.nativePageId === pageId && doc.dataset.nativeWorkspaceId === workspaceId && !doc.closest('[data-page-view-content]'))
      .flatMap(doc => Array.from(doc.querySelectorAll<HTMLElement>(':scope > .michi-doc-block[data-top]')))
      .filter(item => item.dataset.blockId && item.getBoundingClientRect().height > 0);
    let scrollParent: HTMLElement | null = hostElement.parentElement;
    while (scrollParent && !(scrollParent.scrollHeight > scrollParent.clientHeight && /auto|scroll/.test(getComputedStyle(scrollParent).overflowY))) scrollParent = scrollParent.parentElement;

    const locate = () => {
      const items = frames();
      const bounds = scope.getBoundingClientRect();
      if (point.x < bounds.left - 48 || point.x > bounds.right + 48) { target = null; setDrop(null); return; }
      const remaining = items.filter(item => item.dataset.blockId !== id);
      if (!remaining.length) { target = null; setDrop(null); return; }
      const before = remaining.find(item => {
        const rect = item.getBoundingClientRect();
        return point.y < rect.top + rect.height / 2;
      });
      const at = before ? remaining.indexOf(before) : remaining.length;
      const anchor = before ?? remaining[remaining.length - 1];
      const rect = anchor.getBoundingClientRect();
      const beforeId = before?.dataset.blockId;
      const fullOrder = current.page.blocks.filter(item => item.id !== id);
      // A segment may start in the middle of the page. Use the full stored order.
      const fullIndex = beforeId ? fullOrder.findIndex(item => item.id === beforeId) : -1;
      const after = beforeId ? (fullIndex > 0 ? fullOrder[fullIndex - 1].id : null) : remaining[at - 1].dataset.blockId!;
      target = { after, left: rect.left, top: before ? rect.top - 5 : rect.bottom + 5, width: rect.width };
      setDrop(previous => previous?.after === target?.after && previous?.left === target?.left && previous?.top === target?.top && previous?.width === target?.width ? previous : target);
    };
    const tick = () => {
      if (!active) return;
      const bounds = scrollParent?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
      const top = Math.max(0, bounds.top);
      const bottom = Math.min(window.innerHeight, bounds.bottom);
      const delta = point.y < top + 48 ? -Math.min(16, (top + 48 - point.y) / 3)
        : point.y > bottom - 48 ? Math.min(16, (point.y - bottom + 48) / 3) : 0;
      if (delta) {
        if (scrollParent) scrollParent.scrollTop += delta;
        else window.scrollBy(0, delta);
      }
      locate();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      active = false;
      cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', cancel, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      setDragging(null);
      setDrop(null);
      cleanup.current = null;
    };
    const cancel = () => stop();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); }
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      point = { x: e.clientX, y: e.clientY };
      if (!active && Math.hypot(point.x - origin.x, point.y - origin.y) < 5) return;
      e.preventDefault();
      if (!active) {
        active = true;
        dragged.current = true;
        setDragging(id);
        setError(null);
        tick();
      } else locate();
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const destination = active ? target : null;
      stop();
      if (!destination) return;
      const now = latest.current;
      if (now.readOnly || now.page.id !== pageId || now.page.revision !== revision) {
        setError('The page changed while dragging. Try again.');
        return;
      }
      const index = current.page.blocks.findIndex(item => item.id === id);
      if ((current.page.blocks[index - 1]?.id ?? null) === destination.after) return;
      pending.current = true;
      setMoving(true);
      void now.onEdit([{ op: 'move', id, after: destination.after, expectRev: block.rev }], revision)
        .then(result => {
          if (result !== 'ok') setError(result === 'stale' ? 'The page changed while dragging. Try again.' : 'Could not move this block. Try again.');
        }, () => setError('Could not move this block. Try again.'))
        .finally(() => { pending.current = false; setMoving(false); });
    };
    handle.setPointerCapture?.(pointerId);
    document.addEventListener('pointermove', move, { capture: true, passive: false });
    document.addEventListener('pointerup', finish, true);
    document.addEventListener('pointercancel', cancel, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    cleanup.current = stop;
  }, [host]);
  const takeDragged = useCallback(() => { const value = dragged.current; dragged.current = false; return value; }, []);
  return { dragStart, takeDragged, dragging, drop, moving, error };
}
