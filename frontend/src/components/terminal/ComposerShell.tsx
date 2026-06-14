import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
} from 'react';

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

  onDragEnter?: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (e: DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: DragEvent<HTMLDivElement>) => void;
}

export interface ComposerShellHandle {
  /** Underlying root <div>. TPane's ResizeObserver watches this. */
  el: HTMLDivElement | null;
}

const DENSITY_INSET: Record<ComposerShellDensity, number> = {
  dense: 18,
  compact: 20,
  comfortable: 26,
};

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
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop,
    } = props;

    const rootRef = useRef<HTMLDivElement | null>(null);
    const [isFocused, setIsFocused] = useState(false);

    useImperativeHandle(ref, () => ({ el: rootRef.current }), []);

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
    };

    return (
      <div
        ref={rootRef}
        className={className}
        onFocus={() => setIsFocused(true)}
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
          transition: 'background 120ms ease-out, border-color 120ms ease-out, box-shadow 120ms ease-out',
          // Toolbar chips and action buttons inherit this font size. Defaults
          // to 11.5px (matches the historical hard-coded value) but Home
          // overrides via --composer-chrome-size to scale the whole shell up
          // for its hero composer.
          fontSize: 'var(--composer-chrome-size, 11.5px)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {preBlocks}
        <div
          style={{
            padding: '10px 12px 4px 12px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            position: 'relative',
          }}
        >
          {caretAdornments}
          <span
            style={{
              color: 'var(--term-accent)',
              fontFamily:
                'var(--message-latin-font, var(--ui-font)), var(--message-cjk-font, sans-serif)',
              fontSize: 'var(--message-body-size, 12.5px)',
              lineHeight: 'var(--message-body-leading, 19px)',
              flexShrink: 0,
              userSelect: 'none',
            }}
          >
            ›_
          </span>
          {input}
        </div>
        <div
          ref={toolbarRef}
          style={{
            padding: '4px 10px 8px 10px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minHeight: 34,
            // Deliberately NOT overflow:hidden — chip hover tooltips would clip.
            // Each chip owns its own ellipsis, action buttons are flex-shrink:0.
            minWidth: 0,
          }}
        >
          {toolbarLeft}
          <span style={{ flex: 1, minWidth: 0 }} />
          {toolbarRight}
        </div>
      </div>
    );
  },
);
