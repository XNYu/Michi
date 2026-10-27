import React from 'react';
import { ChevronRight, MessageSquare, X } from 'lucide-react';
import { PopoverSurface } from '../../ui/Popover';
import { Button } from '../../ui/controls';
import { useAnchoredPosition } from '../../ui/useAnchoredPosition';
import { formatMichiAge } from '../content/michiFormat';
import { fetchSourcePreview, type SourcePreview } from '../../../state/sourceNav/sourceApi';
import type { SourcePopoverState } from '../../../state/sourceNav/sourceNav';
import './source.css';

const WIDTH = 384;
const GAP = 6;
const PAD = 8;
/** The popover starts a little left of the link, so the link reads as its source. */
const LEAD = 40;

const RUNTIME_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', kiro: 'Kiro', pi: 'Pi', crew: 'Crew' };

export function runtimeLabel(runtimeId: string | null | undefined): string | null {
  if (!runtimeId) return null;
  return RUNTIME_LABELS[runtimeId] ?? runtimeId;
}

export function sourceAge(at: number | null | undefined, now = Date.now()): string {
  if (at == null) return '';
  const age = formatMichiAge(at, now);
  return age === 'now' ? 'just now' : `${age} ago`;
}

type Loaded = { status: 'loading' } | { status: 'ready'; preview: SourcePreview } | { status: 'missing' } | { status: 'error' };

export interface SourcePopoverProps {
  popover: SourcePopoverState;
  onClose: () => void;
  /** `focus`: Continue (cursor in the composer) rather than Open. */
  onGo: (focus: boolean, preview: SourcePreview | null) => void;
}

/** One conversation message a page or a Home item points at, with the two ways into its conversation. */
export function SourcePopover({ popover, onClose, onGo }: SourcePopoverProps) {
  const { target, anchor } = popover;
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const focusRef = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null);
  const [loaded, setLoaded] = React.useState<Loaded>({ status: 'loading' });
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  React.useEffect(() => {
    const controller = new AbortController();
    setLoaded({ status: 'loading' });
    void fetchSourcePreview(target.backendConnectionId, { nodeId: target.nodeId, messageId: target.messageId }, controller.signal)
      .then((preview) => { if (!controller.signal.aborted) setLoaded(preview ? { status: 'ready', preview } : { status: 'missing' }); })
      .catch(() => { if (!controller.signal.aborted) setLoaded({ status: 'error' }); });
    return () => controller.abort();
  }, [target.backendConnectionId, target.nodeId, target.messageId]);

  useAnchoredPosition({
    anchor,
    surfaceRef,
    measure: () => {
      const box = surfaceRef.current?.getBoundingClientRect();
      const width = box?.width || WIDTH;
      const height = box?.height || 0;
      if (!anchor) { setPosition({ left: Math.max(PAD, (window.innerWidth - width) / 2), top: 96 }); return; }
      // The page under it went away (another page opened): so does the popover.
      if (!anchor.isConnected) { onCloseRef.current(); return; }
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(PAD, Math.min(window.innerWidth - width - PAD, rect.left - LEAD));
      let top = rect.bottom + GAP;
      if (top + height > window.innerHeight - PAD && rect.top - GAP - height >= PAD) top = rect.top - GAP - height;
      setPosition((current) => current && current.left === left && current.top === top ? current : { left, top });
    },
    dependencies: [loaded.status],
  });

  React.useEffect(() => {
    focusRef.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      anchor?.focus({ preventScroll: true });
      onCloseRef.current();
    };
    const onPointer = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && (surfaceRef.current?.contains(node) || anchor?.contains(node))) return;
      onCloseRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [anchor]);

  const preview = loaded.status === 'ready' ? loaded.preview : null;
  const gone = loaded.status === 'missing' || preview?.state === 'deleted';
  const archived = preview?.state === 'archived';
  const closed = gone || archived;
  const runtime = runtimeLabel(preview?.runtimeId);
  const meta = [preview?.workspaceName, sourceAge(preview?.message?.at)].filter(Boolean).join(' · ');
  const title = preview?.title || (loaded.status === 'loading' ? '' : 'Conversation');
  const text = gone ? '' : preview?.message?.text ?? '';

  return (
    <PopoverSurface
      ref={surfaceRef}
      role="dialog"
      aria-label={title ? `Source: ${title}` : 'Source'}
      className="source-pop"
      width={WIDTH}
      maxWidth={`calc(100vw - ${PAD * 2}px)`}
      left={position?.left ?? 0}
      top={position?.top ?? 0}
      style={position ? undefined : { visibility: 'hidden' }}
    >
      <div ref={focusRef} tabIndex={-1} className="source-pop__focus" />
      <header className="source-pop__head">
        <MessageSquare size={13} strokeWidth={1.7} aria-hidden="true" />
        <span className="source-pop__kind">Source</span>
        <strong className="source-pop__title" title={title}>{title}</strong>
        {runtime && <span className="source-pop__tag">{runtime}</span>}
        {meta && <span className="source-pop__meta">{meta}</span>}
        <span className="source-pop__spacer" />
        <button type="button" className="t-icon-btn source-pop__close" aria-label="Close" onClick={() => { anchor?.focus({ preventScroll: true }); onClose(); }}>
          <X size={13} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </header>
      {loaded.status === 'loading' && <blockquote className="source-pop__quote source-pop__quote--loading" aria-busy="true">Loading the message…</blockquote>}
      {text && <blockquote className="source-pop__quote">{text}</blockquote>}
      {loaded.status === 'ready' && !text && !closed && <p className="source-pop__note">This message is no longer in the conversation.</p>}
      {loaded.status === 'error' && <p className="source-pop__note" role="status">The message could not be loaded.</p>}
      <div className="source-pop__actions">
        <Button variant="primary" size="sm" disabled={closed || loaded.status === 'loading'} onClick={() => onGo(true, preview)}>
          Continue this chat <ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />
        </Button>
        <Button size="sm" disabled={closed || loaded.status === 'loading'} onClick={() => onGo(false, preview)}>Open full chat</Button>
      </div>
      {closed
        ? <p className="source-pop__note source-pop__note--closed" role="status">{gone ? 'This conversation was deleted.' : 'This conversation is archived.'}</p>
        : <p className="source-pop__hint">Both open the conversation page, which has “Back to page”.</p>}
    </PopoverSurface>
  );
}
