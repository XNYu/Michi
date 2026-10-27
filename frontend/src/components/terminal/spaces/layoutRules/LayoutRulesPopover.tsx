import React from 'react';
import type { HomeSectionKey, PageLayoutRule } from 'michi-shared';
import { PopoverSurface } from '../../../ui/Popover';
import { Button } from '../../../ui/controls';
import { formatMichiAge } from '../../content/michiFormat';
import { LayoutPreferencesEditor } from './LayoutPreferencesEditor';
import '../../content/page/michiPage.css';
import './layoutRules.css';

const GAP = 4;
const PAD = 8;
const WIDTH = 320;
const SECTION: Record<HomeSectionKey, string> = { waiting: 'Waiting', stalled: 'Stalled', done: 'Done' };

/** Who the rule binds and where it came from: "Stalled · applied by Michi · from your message · 2h ago". */
export function layoutRuleMeta(rule: PageLayoutRule, now = Date.now()): string {
  const age = formatMichiAge(rule.createdAt, now);
  return [
    rule.sectionLimit ? `${SECTION[rule.sectionLimit.section]} · applied by Michi` : 'followed by the Meta agent',
    rule.createdBy === 'user' ? 'added by you' : rule.sourceMessage ? 'from your message to the assistant' : null,
    age ? (age === 'now' ? 'just now' : `${age} ago`) : null,
  ].filter(Boolean).join(' · ');
}

/**
 * The page's layout rules hung from its ⋯ button: each rule's text, what it
 * binds and a Delete. Esc or a click outside closes it; focus goes back to
 * the button on Esc.
 */
export function LayoutRulesPopover({ anchor, rules, error, readOnly, preferences, onDelete, onClose }: {
  anchor: HTMLElement;
  rules: readonly PageLayoutRule[] | null;
  error?: string | null;
  readOnly?: boolean;
  preferences?: { pageId: string; backendConnectionId: string };
  onDelete: (rule: PageLayoutRule) => Promise<void>;
  onClose: (restoreFocus: boolean) => void;
}) {
  const surface = React.useRef<HTMLDivElement>(null);
  const [position, setPosition] = React.useState<{ left: number; top: number } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const editableDocument = Boolean(preferences);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const box = surface.current?.getBoundingClientRect();
      const w = box?.width || (editableDocument ? 440 : WIDTH);
      const h = box?.height || 0;
      const left = Math.max(PAD, Math.min(window.innerWidth - w - PAD, rect.right - w));
      let top = rect.bottom + GAP;
      if (top + h > window.innerHeight - PAD && rect.top - GAP - h >= PAD) top = rect.top - GAP - h;
      setPosition(current => current?.left === left && current.top === top ? current : { left, top });
    };
    place();
    if (!editableDocument) return undefined;
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (surface.current) observer?.observe(surface.current);
    return () => { window.removeEventListener('resize', place); observer?.disconnect(); };
  }, [anchor, rules?.length, editableDocument]);

  React.useEffect(() => {
    surface.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surface.current?.contains(target) || anchor.contains(target))) return;
      closeRef.current(false);
    };
    const dismiss = () => closeRef.current(false);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    if (!editableDocument) window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [anchor, editableDocument]);

  const remove = async (rule: PageLayoutRule) => {
    if (busy) return;
    setBusy(rule.id);
    setFailed(null);
    try {
      await onDelete(rule);
    } catch (cause) {
      setFailed(cause instanceof Error && cause.message ? `Couldn't delete: ${cause.message}` : "Couldn't delete this rule.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <PopoverSurface
      ref={surface}
      menuKind="context"
      animate={false}
      width={preferences ? 440 : WIDTH}
      maxHeight={`calc(100vh - ${position?.top ?? PAD}px - ${PAD}px)`}
      left={position?.left ?? 0}
      top={position?.top ?? 0}
      role="dialog"
      aria-label={preferences ? 'Layout preferences' : 'Layout rules'}
      className="michi-doc-menu layout-rules-menu"
      style={position ? undefined : { visibility: 'hidden' }}
    >
      <ul className="michi-menu-list">
        <li className="michi-menu-section michi-doc-menu__caption" role="presentation">{preferences ? 'Layout preferences' : 'Layout rules'}</li>
        {preferences && <li className="layout-rules-menu__document"><LayoutPreferencesEditor {...preferences} readOnly={readOnly} /></li>}
        {preferences && <li className="michi-menu-section michi-doc-menu__caption" role="presentation">Existing rules</li>}
        {rules === null && !error && <li className="layout-rules-menu__note" role="status">Loading…</li>}
        {rules === null && error && <li className="layout-rules-menu__note" role="alert">{error}</li>}
        {rules?.length === 0 && (
          <li className="layout-rules-menu__note">
            No layout rules yet. Ask the Meta agent, for example “Stalled: only the last 3 days”.
          </li>
        )}
        {rules?.map((rule) => (
          <li key={rule.id} className="ui-menu-item michi-doc-menu__item--sub layout-rules-menu__rule" data-testid="layout-rule">
            <span className="michi-menu-label michi-doc-menu__label">
              <span className="michi-doc-menu__title">{rule.text}</span>
              <span className="michi-doc-menu__sub">{layoutRuleMeta(rule)}</span>
            </span>
            <Button variant="ghost" size="sm" danger disabled={readOnly || busy !== null} aria-label={`Delete rule: ${rule.text}`}
              aria-busy={busy === rule.id || undefined} onClick={() => { void remove(rule); }}>
              Delete
            </Button>
          </li>
        ))}
        {failed && <li className="layout-rules-menu__note" role="alert">{failed}</li>}
      </ul>
    </PopoverSurface>
  );
}
