import React, { useRef, useState, useMemo, useCallback, useEffect } from 'react';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { lastInputWasTouch } from '../../lib/inputModality';
import { PopoverSurface } from '../ui/Popover';
import { useAnchoredPosition } from '../ui/useAnchoredPosition';

export interface ContextRingProps {
  /** 0–100 percentage of context window consumed. undefined/null = hidden. */
  percentage: number | undefined | null;
  /** Optional token breakdown for the tooltip. */
  usageSummary?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
  };
}

/** The ring stays out of the toolbar until more than half the window is used. */
export const CONTEXT_RING_MIN_PERCENT = 50;

/** Toolbar icon sizes (PaneComposerToolbarLeft): 16px on desktop, 18px on a phone. */
const RING_DESKTOP = { size: 16, stroke: 1.75 };
const RING_PHONE = { size: 18, stroke: 2 };

/**
 * Color ramp: green → yellow → orange → red as context fills up.
 * Exactly four stops, linearly interpolated.
 */
function ringColor(pct: number): string {
  if (pct < 50) return 'var(--term-digest)';
  if (pct < 75) return 'var(--term-select)';
  if (pct < 90) return 'color-mix(in srgb, var(--term-select) 50%, var(--term-danger))';
  return 'var(--term-danger)';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Minimal SVG donut ring showing context-window usage, without a number.
 * Sits in the composer toolbar, just left of Branch/Send, as an icon-only
 * chip so ComposerShell treats a tap on it like its other controls (the
 * keyboard stays up and the field is not refocused). Hidden until usage
 * passes CONTEXT_RING_MIN_PERCENT.
 *
 * On hover, shows a styled tooltip with "Context usage: 75%" prominently
 * and optional token breakdown details below. A touch screen has no hover, so
 * a tap toggles the same card and the next tap outside the ring closes it.
 */
export const ContextRing = React.memo(function ContextRing({
  percentage,
  usageSummary,
}: ContextRingProps) {
  const rawPct = percentage ?? 0;
  const pct = Number.isFinite(rawPct) ? Math.min(100, Math.max(0, rawPct)) : 0;
  const visible = percentage != null && pct > CONTEXT_RING_MIN_PERCENT;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const { size, stroke } = usePhoneLayout() ? RING_PHONE : RING_DESKTOP;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  const style = useMemo(() => {
    const offset = circumference - (pct / 100) * circumference;
    return {
      strokeDasharray: `${circumference} ${circumference}`,
      strokeDashoffset: offset,
      transition: 'stroke-dashoffset var(--t-decay) ease-out, stroke var(--t-decay) ease-out',
    };
  }, [pct, circumference]);

  const onEnter = useCallback(() => { if (!lastInputWasTouch()) setHovered(true); }, []);
  const onLeave = useCallback(() => { if (!lastInputWasTouch()) setHovered(false); }, []);
  const onTap = useCallback(() => { if (lastInputWasTouch()) setHovered(open => !open); }, []);
  const close = useCallback(() => setHovered(false), []);

  useEffect(() => {
    if (!hovered) return;
    const closeOutside = (event: PointerEvent) => {
      if (!anchorRef.current?.contains(event.target as Node)) setHovered(false);
    };
    document.addEventListener('pointerdown', closeOutside, true);
    return () => document.removeEventListener('pointerdown', closeOutside, true);
  }, [hovered]);

  if (!visible) return null;

  const color = ringColor(pct);
  const summary = usageSummary;
  const centre = size / 2;

  return (
    <>
      <div
        ref={anchorRef}
        className="t-toolbar-chip is-icon-only composer-context-ring"
        data-icononly="true"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={onTap}
        aria-label={`Context usage: ${pct.toFixed(0)}%`}
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden="true"
        >
          {/* Track (background ring) */}
          <circle
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            stroke="var(--term-line)"
            strokeWidth={stroke}
          />
          {/* Progress arc */}
          <circle
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            transform={`rotate(-90 ${centre} ${centre})`}
            style={style}
          />
        </svg>
      </div>

      {hovered && <ContextRingTooltip anchorRef={anchorRef} pct={pct} color={color} summary={summary} onDismiss={close} />}
    </>
  );
});

/* ------------------------------------------------------------------ */
/*  Tooltip                                                           */
/* ------------------------------------------------------------------ */

interface TooltipProps {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  pct: number;
  color: string;
  summary?: ContextRingProps['usageSummary'];
  /** The ring left the layout (the phone composer settled to its one-row rest). */
  onDismiss: () => void;
}

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 8;

function ContextRingTooltip({ anchorRef, pct, color, summary, onDismiss }: TooltipProps) {
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  // The surface hugs its content, so centre it on the ring using its measured
  // width. The first pass (nothing mounted yet) places it at the ring's centre;
  // the pass after mount corrects it before paint. useAnchoredPosition measures
  // again whenever the ring or the viewport moves: a phone keyboard rising or
  // falling pans the visual viewport, and the card must follow the ring.
  const measure = React.useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    if (el.checkVisibility?.() === false) {
      onDismiss();
      return;
    }
    const r = el.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewLeft = viewport?.offsetLeft ?? 0;
    const viewWidth = viewport?.width ?? window.innerWidth;
    const width = surfaceRef.current?.offsetWidth ?? 0;
    const left = Math.max(
      viewLeft + VIEWPORT_MARGIN,
      Math.min(r.left + r.width / 2 - width / 2, viewLeft + viewWidth - width - VIEWPORT_MARGIN),
    );
    const top = r.top - ANCHOR_GAP;
    setPos((prev) => (
      prev !== null && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5
        ? prev
        : { left, top }
    ));
  }, [anchorRef, onDismiss]);

  // Re-measure after mount (hasPosition flips once) and whenever the text, and
  // so the width, changes.
  const hasPosition = pos !== null;
  useAnchoredPosition({ anchor: anchorRef.current, surfaceRef, measure, dependencies: [hasPosition, pct, summary] });

  if (!pos) return null;

  const hasDetails = summary && (
    summary.totalTokens !== undefined ||
    summary.inputTokens !== undefined
  );

  return (
    <PopoverSurface
      ref={surfaceRef}
      variant="tooltip"
      menuKind="usage"
      className="michi-menu-usage"
      width="var(--m-width)"
      maxWidth="calc(100vw - 16px)"
      left={pos.left}
      top={pos.top}
      role="tooltip"
      style={{
        transform: 'translateY(-100%)',
      }}
    >
      {/* Primary: percentage with color-matched value */}
      <span
        className="michi-menu-usage-primary"
        data-testid="context-ring-tooltip-pct"
      >
        <span style={{ color: 'var(--term-mid)' }}>Context:</span>
        <span style={{ color, fontVariantNumeric: 'tabular-nums' }}>
          {pct.toFixed(1)}%
        </span>
      </span>

      {/* Secondary: token details when available */}
      {hasDetails && (
        <span
          className="michi-menu-usage-details"
          data-testid="context-ring-tooltip-details"
        >
          {summary!.totalTokens !== undefined && (
            <span>{formatTokens(summary!.totalTokens)} tokens</span>
          )}
          {summary!.inputTokens !== undefined && summary!.outputTokens !== undefined && (
            <span>in {formatTokens(summary!.inputTokens)} · out {formatTokens(summary!.outputTokens)}</span>
          )}
        </span>
      )}
      {hasDetails && summary!.cachedInputTokens !== undefined && summary!.cachedInputTokens > 0 && (
        <span
          className="michi-menu-usage-details"
        >
          cached {formatTokens(summary!.cachedInputTokens)}
          {summary!.reasoningOutputTokens ? ` · reasoning ${formatTokens(summary!.reasoningOutputTokens)}` : ''}
        </span>
      )}
    </PopoverSurface>
  );
}
