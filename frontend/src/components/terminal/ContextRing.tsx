import React, { useRef, useState, useMemo, useCallback } from 'react';
import { PopoverSurface } from '../ui/Popover';

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

const SIZE = 20;
const STROKE = 2.4;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Color ramp: green → yellow → orange → red as context fills up.
 * Exactly four stops, linearly interpolated.
 */
function ringColor(pct: number): string {
  if (pct < 50) return 'var(--color-success, #34a853)';
  if (pct < 75) return 'var(--color-warn, #f9ab00)';
  if (pct < 90) return 'var(--color-orange, #e8710a)';
  return 'var(--color-error, #ea4335)';
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Minimal SVG donut ring showing context-window usage.
 * Sits in the composer toolbar, just left of the Send button.
 * Hidden when no context data is available.
 *
 * On hover, shows a styled tooltip with "Context usage: 75%" prominently
 * and optional token breakdown details below.
 */
export const ContextRing = React.memo(function ContextRing({
  percentage,
  usageSummary,
}: ContextRingProps) {
  const pct = percentage ?? 0;
  const visible = percentage != null && percentage > 0;
  const anchorRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  const style = useMemo(() => {
    const offset = CIRCUMFERENCE - (pct / 100) * CIRCUMFERENCE;
    return {
      strokeDasharray: `${CIRCUMFERENCE} ${CIRCUMFERENCE}`,
      strokeDashoffset: offset,
      transition: 'stroke-dashoffset 400ms ease-out, stroke 300ms ease-out',
    };
  }, [pct]);

  const onEnter = useCallback(() => setHovered(true), []);
  const onLeave = useCallback(() => setHovered(false), []);

  if (!visible) return null;

  const color = ringColor(pct);
  const summary = usageSummary;

  return (
    <>
      <div
        ref={anchorRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        aria-label={`Context usage: ${pct.toFixed(0)}%`}
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: SIZE,
          height: SIZE,
          flexShrink: 0,
          cursor: 'default',
          opacity: pct < 10 ? 0.5 : 1,
          transition: 'opacity 300ms ease-out',
        }}
      >
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          aria-hidden="true"
        >
          {/* Track (background ring) */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="var(--term-line-m, rgba(128,128,128,0.15))"
            strokeWidth={STROKE}
          />
          {/* Progress arc */}
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={STROKE}
            strokeLinecap="round"
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            style={style}
          />
        </svg>
      </div>

      {hovered && <ContextRingTooltip anchorRef={anchorRef} pct={pct} color={color} summary={summary} />}
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
}

function ContextRingTooltip({ anchorRef, pct, color, summary }: TooltipProps) {
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);

  React.useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Position above the ring, centered horizontally
    setPos({ left: r.left + r.width / 2, top: r.top - 8 });
  }, [anchorRef]);

  if (!pos) return null;

  const hasDetails = summary && (
    summary.totalTokens !== undefined ||
    summary.inputTokens !== undefined
  );

  return (
    <PopoverSurface
      variant="tooltip"
      left={pos.left}
      top={pos.top}
      role="tooltip"
      style={{
        transform: 'translate(-50%, -100%)',
        padding: '6px 10px',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      {/* Primary: percentage with color-matched value */}
      <span
        style={{
          fontSize: 11.5,
          fontWeight: 500,
          color: 'var(--term-fg)',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
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
          style={{
            fontSize: 10,
            color: 'var(--term-faint)',
            display: 'flex',
            gap: 8,
            fontVariantNumeric: 'tabular-nums',
          }}
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
          style={{
            fontSize: 10,
            color: 'var(--term-faint)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          cached {formatTokens(summary!.cachedInputTokens)}
          {summary!.reasoningOutputTokens ? ` · reasoning ${formatTokens(summary!.reasoningOutputTokens)}` : ''}
        </span>
      )}
    </PopoverSurface>
  );
}
