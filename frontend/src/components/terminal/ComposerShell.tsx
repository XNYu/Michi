import './mobile.css';
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { useKeyboardDismiss } from '../../hooks/useKeyboardDismiss';
import { composerMotionAllowed, morphComposer, snapshotComposer, type ComposerSnapshot } from './composerMorph';

export type ComposerShellPosition = 'absolute' | 'static';
export type ComposerShellDensity = 'compact' | 'dense' | 'comfortable';

export interface ComposerShellProps {
  /** absolute = floats over scroll area (TPane). static = inline (Home). */
  position?: ComposerShellPosition;
  /** TPane only: density-aware horizontal insets. Ignored when position=static. */
  density?: ComposerShellDensity;
  /** TPane only: clamp width + center via auto margins. Ignored when position=static. */
  contentMaxWidth?: number | null;
  /** Render outline highlight while a drag-and-drop file hovers the composer. */
  dragHover?: boolean;

  /** Pre-blocks above the caret row: queued, comments, quote, attachments. */
  preBlocks?: ReactNode;
  /** Floating popups anchored to the input (SlashPopup, AtMentionPopup). */
  caretAdornments?: ReactNode;
  /** The MentionEditor (or any input). Caller owns the ref + key handlers. */
  input: ReactNode;
  /** Left side of the toolbar row (chips). */
  toolbarLeft?: ReactNode;
  /** Right side of the toolbar row (action buttons). */
  toolbarRight?: ReactNode;

  /** Optional ref to the inner toolbar wrapper, used by TPane for ResizeObserver. */
  toolbarRef?: React.Ref<HTMLDivElement>;

  /**
   * On a phone, rest as one row (attach, field, send/stop) until the user
   * engages it; tapping outside settles it again.
   */
  collapsible?: boolean;
  /** The draft has text, so the full composer stays open. */
  hasContent?: boolean;
  /** A toolbar menu is open, so the chip that opened it must stay in place. */
  holdOpen?: boolean;
  /** Muted placeholder for the empty field. On a phone it stands in for ›_. */
  collapsedHint?: string;

  onDragEnter?: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
}

export interface ComposerShellHandle {
  /** Underlying root <div>. TPane's ResizeObserver watches this. */
  el: HTMLDivElement | null;
  /**
   * After a send on a phone: leave the field, which lowers the keyboard, and
   * rest as one row again. Does nothing where the composer cannot collapse.
   */
  settle: () => void;
}

const DENSITY_INSET: Record<ComposerShellDensity, number> = {
  dense: 18,
  compact: 20,
  comfortable: 26,
};

/** The text field inside the caret row: the MentionEditor or a plain input. */
const FIELD = [
  '[contenteditable="true"]',
  'textarea',
  '[role="textbox"]',
].map((selector) => `.terminal-composer__input ${selector}`).join(', ');
/** A pressable composer control: chips (+, @, agent, model) and action buttons. */
const TOOLBAR_CONTROL = 'button, [role="button"], .t-toolbar-chip, .t-action-btn';

/**
 * Pure-visual composer shell. Owns the card frame (border, shadow,
 * focus state) and the caret/toolbar row layout. Knows nothing about
 * drafts, nodes, agents, or sending — slots get filled by callers.
 */
export const ComposerShell = forwardRef<ComposerShellHandle, ComposerShellProps>(
  function ComposerShell(props, ref) {
    const {
      position = 'absolute',
      density = 'comfortable',
      contentMaxWidth,
      dragHover = false,
      preBlocks,
      caretAdornments,
      input,
      toolbarLeft,
      toolbarRight,
      toolbarRef,
      collapsible = false,
      hasContent = false,
      holdOpen = false,
      collapsedHint,
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
    } = props;

    const rootRef = useRef<HTMLDivElement | null>(null);
    const preBlocksRef = useRef<HTMLDivElement | null>(null);
    const [isFocused, setIsFocused] = useState(false);
    const phone = usePhoneLayout();
    const canCollapse = collapsible && phone;
    const [engaged, setEngaged] = useState(false);
    // Queued messages, quotes and attachments render here; never hide them.
    const [hasPreBlocks, setHasPreBlocks] = useState(false);
    useLayoutEffect(() => {
      const filled = (preBlocksRef.current?.childElementCount ?? 0) > 0;
      if (filled !== hasPreBlocks) setHasPreBlocks(filled);
    }, [preBlocks, hasPreBlocks]);
    // Settle on a tap elsewhere, not on blur: Safari does not focus a tapped
    // button, so blurring on the way to a toolbar chip would hide the chip
    // before its click lands. Menus and pickers render in portals.
    useEffect(() => {
      if (!canCollapse || !engaged) return;
      const onPointerDown = (event: PointerEvent) => {
        const target = event.target as Element | null;
        if (!target || rootRef.current?.contains(target)) return;
        if (target.closest('[role="menu"], [role="dialog"], [role="listbox"]')) return;
        setEngaged(false);
      };
      document.addEventListener('pointerdown', onPointerDown, true);
      return () => document.removeEventListener('pointerdown', onPointerDown, true);
    }, [canCollapse, engaged]);
    // Whenever the keyboard goes down, rest as one row, even with a draft or
    // pre-blocks; the next engagement opens it again. Android's back key
    // lowers the keyboard but leaves focus in the field, so let go of it too.
    const [resting, setResting] = useState(false);
    useKeyboardDismiss(canCollapse, () => fieldHasFocus(), () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
      setEngaged(false);
      setResting(true);
    });
    const engage = () => {
      setEngaged(true);
      setResting(false);
    };
    // A menu opened from a chip still needs that chip; it rests once the menu closes.
    const collapsed = canCollapse && !holdOpen && (resting || (!engaged && !hasContent && !hasPreBlocks));
    const canCollapseRef = useRef(canCollapse);
    canCollapseRef.current = canCollapse;

    // Animate between the one-row rest and the open composer (composerMorph).
    // Each commit records the settled layout, so a change animates from what
    // was on screen. While an animation runs its transforms would skew the
    // record, so it is taken again when the animation ends.
    const frameRef = useRef<HTMLDivElement | null>(null);
    const settledRef = useRef<ComposerSnapshot | null>(null);
    const shownCollapsedRef = useRef(collapsed);
    const endMorphRef = useRef<(() => void) | null>(null);
    useLayoutEffect(() => {
      const root = rootRef.current;
      const changed = shownCollapsedRef.current !== collapsed;
      shownCollapsedRef.current = collapsed;
      if (!canCollapse || !root) {
        endMorphRef.current?.();
        settledRef.current = null;
        return;
      }
      if (!changed && endMorphRef.current) return;
      const prev = settledRef.current;
      endMorphRef.current?.();
      const next = snapshotComposer(root);
      settledRef.current = next;
      const frame = frameRef.current;
      if (!changed || !prev || !frame || !composerMotionAllowed()) return;
      let end: (() => void) | null = null;
      let finished = false;
      end = morphComposer(root, frame, prev, next, () => {
        finished = true;
        if (endMorphRef.current === end) endMorphRef.current = null;
        if (rootRef.current) settledRef.current = snapshotComposer(rootRef.current);
      });
      if (!finished) endMorphRef.current = end;
    });
    useEffect(() => () => endMorphRef.current?.(), []);
    // An IME (Chinese, Japanese) holds text before the draft sees it.
    const [composing, setComposing] = useState(false);
    // On the phone the hint is the empty field's placeholder, in place of ›_.
    const hintAsPlaceholder = canCollapse && !!collapsedHint;
    const showHint = hintAsPlaceholder && !hasContent && !composing;

    const field = () =>
      rootRef.current?.querySelector<HTMLElement>(FIELD) ?? null;
    const fieldHasFocus = () => {
      const el = field();
      return !!el && el.contains(document.activeElement);
    };

    // Engage on the click, not on pointerdown: opening the composer moves the
    // field, so Safari's tap would otherwise land on the toolbar row and the
    // keyboard would not come up. A tap beside the text still focuses the
    // field inside the same gesture, which iOS requires to show the keyboard.
    const handleClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!canCollapse) return;
      if (collapsed) engage();
      const target = e.target as Element;
      if (target.closest(TOOLBAR_CONTROL) || target.closest('.composer-pre-blocks-scroll') || fieldHasFocus()) return;
      const el = field();
      if (!el) return;
      el.focus({ preventScroll: true });
      if (el instanceof HTMLTextAreaElement) {
        el.setSelectionRange(el.value.length, el.value.length);
      } else if (el.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(el.lastElementChild ?? el);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    };

    // Phone: pressing a toolbar control that does not open a menu (+, @,
    // send) leaves focus in the field, so iOS keeps the keyboard up. Menu
    // triggers still take the tap, as their menus expect.
    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
      if (!phone) return;
      const control = (e.target as Element).closest(TOOLBAR_CONTROL);
      if (!control || !control.closest('.terminal-composer__toolbar')) return;
      if (control.matches('[aria-haspopup]') || !fieldHasFocus()) return;
      e.preventDefault();
    };

    useImperativeHandle(ref, () => ({
      el: rootRef.current,
      settle: () => {
        if (!canCollapseRef.current) return;
        const active = document.activeElement;
        if (active instanceof HTMLElement && rootRef.current?.contains(active)) active.blur();
        setEngaged(false);
      },
    }), []);

    const className =
      'terminal-composer' +
      (position === 'static' ? ' is-static' : '') +
      (dragHover ? ' is-drag-hover' : '');

    const positionStyle: CSSProperties =
      position === 'absolute'
        ? {
            position: 'absolute',
            left: DENSITY_INSET[density],
            right: DENSITY_INSET[density],
            ...(contentMaxWidth != null
              ? { maxWidth: contentMaxWidth, marginLeft: 'auto', marginRight: 'auto' }
              : {}),
            bottom: 12,
            zIndex: 1,
          }
        : {};

    const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
      if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
      setIsFocused(false);
      // Keyboard focus moved elsewhere (a tap elsewhere has no related target).
      if (e.relatedTarget) setEngaged(false);
    };

    return (
      <div
        ref={rootRef}
        className={className}
        data-collapsed={collapsed || undefined}
        onFocus={() => { setIsFocused(true); if (canCollapse) engage(); }}
        onClickCapture={canCollapse ? handleClickCapture : undefined}
        onMouseDown={phone ? handleMouseDown : undefined}
        onCompositionStart={hintAsPlaceholder ? () => setComposing(true) : undefined}
        onCompositionEnd={hintAsPlaceholder ? () => setComposing(false) : undefined}
        onBlur={handleBlur}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        style={{
          ...positionStyle,
          background: 'var(--term-composer-bg, var(--term-bg))',
          border: 'var(--term-composer-border, 1px solid var(--term-line-s))',
          borderRadius: 'var(--term-composer-radius, 0px)',
          boxShadow: isFocused
            ? 'var(--term-composer-shadow, 0 1px 0 rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.10))'
            : 'var(--term-composer-shadow-muted, 0 1px 0 rgba(0,0,0,0.03), 0 1px 3px rgba(0,0,0,0.06))',
          transition: 'background var(--t-soft) ease-out, border-color var(--t-soft) ease-out, box-shadow var(--t-soft) ease-out',
          // Shell chrome inherits this font size. Defaults to --fs-md; Home
          // overrides via --composer-chrome-size to scale the whole shell up
          // for its hero composer.
          fontSize: 'var(--composer-chrome-size, var(--fs-md))',
          display: 'flex',
          flexDirection: collapsed ? 'row' : 'column',
          alignItems: collapsed ? 'center' : undefined,
        }}
      >
        {/* Draws the frame while the open/close animation runs (mobile.css). */}
        {canCollapse && <div ref={frameRef} className="terminal-composer__morph" aria-hidden="true" />}
        {preBlocks && (
          <div
            ref={preBlocksRef}
            className="composer-pre-blocks-scroll hide-sb"
            style={{
              maxHeight: 'var(--composer-pre-blocks-max-h, 260px)',
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          >
            {preBlocks}
          </div>
        )}
        <div
          className="terminal-composer__input"
          style={{
            padding: 'var(--composer-input-padding, 10px 12px 4px 12px)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            position: 'relative',
          }}
        >
          {caretAdornments}
          {showHint && <span className="terminal-composer__hint" aria-hidden="true">{collapsedHint}</span>}
          {!hintAsPlaceholder && (
          <span
            className="terminal-composer__prompt"
            aria-hidden="true"
            style={{
              color: 'var(--term-accent)',
              fontFamily: 'var(--ui-font)',
              fontSize: 'var(--composer-body-size, var(--message-body-size, 12.5px))',
              lineHeight: 'var(--message-body-leading, 19px)',
              flexShrink: 0,
              userSelect: 'none',
            }}
          >
            ›_
          </span>
          )}
          {input}
        </div>
        <div
          ref={toolbarRef}
          className="terminal-composer__toolbar"
          style={{
            padding: 'var(--composer-toolbar-padding, 4px 10px 8px 10px)',
            // At rest its kept controls join the input row.
            display: collapsed ? 'contents' : 'flex',
            alignItems: 'center',
            gap: 4,
            minHeight: 34,
            // Deliberately NOT overflow:hidden — chip hover tooltips would clip.
            // Each chip owns its own ellipsis, action buttons are flex-shrink:0.
            minWidth: 0,
          }}
        >
          {toolbarLeft}
          {!collapsed && <span style={{ flex: 1, minWidth: 0 }} />}
          {toolbarRight}
        </div>
      </div>
    );
  },
);
