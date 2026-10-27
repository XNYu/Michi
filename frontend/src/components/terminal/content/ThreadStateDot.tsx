import React from 'react';
import type { MichiThreadState } from 'michi-shared';
import { michiStateLabel } from './michiFormat';
import './michi.css';

/**
 * What the glyph draws. The first six are Michi's thread states
 * (`agent-done` = a done the user has not confirmed); the rest are Michi's
 * own: `running` (a Michi turn is streaming), `live` (the conversation was
 * resumed here), `read-failed` (Michi couldn't read it).
 */
export type MichiDotKind =
  | 'waiting' | 'doing' | 'stalled' | 'done' | 'agent-done' | 'idea'
  | 'running' | 'live' | 'read-failed';

export function michiDotKind(state: MichiThreadState, doneBy?: 'user' | 'agent'): MichiDotKind {
  return state === 'done' && doneBy === 'agent' ? 'agent-done' : state;
}

const KIND_LABEL: Record<Exclude<MichiDotKind, MichiThreadState | 'agent-done'>, string> = {
  running: 'Running now',
  live: 'Live in Michi',
  'read-failed': "Couldn't be read",
};

function kindLabel(kind: MichiDotKind): string {
  if (kind === 'running' || kind === 'live' || kind === 'read-failed') return KIND_LABEL[kind];
  return kind === 'agent-done' ? michiStateLabel('done', 'agent') : michiStateLabel(kind);
}

/** Pixel box per named size: `lg` is the section-header glyph. */
const NAMED_SIZE = { lg: 13 } as const;

type DotIdentity =
  | { state: MichiThreadState; doneBy?: 'user' | 'agent'; kind?: MichiDotKind }
  | { state?: MichiThreadState; doneBy?: 'user' | 'agent'; kind: MichiDotKind };

/**
 * A thread's state as one small glyph. Shape and colour change together so
 * the state never depends on colour alone (filled dot, ring, half-filled ring,
 * check mark, dashed ring, small faint dot; a turning arc while running, a
 * haloed dot while live here). `kind` overrides what `state`/`doneBy` imply.
 */
export function ThreadStateDot({
  state,
  doneBy,
  kind: kindOverride,
  size = 10,
  title,
}: DotIdentity & {
  size?: number | keyof typeof NAMED_SIZE;
  title?: string;
}) {
  const kind = kindOverride ?? michiDotKind(state as MichiThreadState, doneBy);
  const px = typeof size === 'number' ? size : NAMED_SIZE[size];
  return (
    <svg
      role="img"
      aria-label={kindLabel(kind)}
      data-state={kind}
      data-size={typeof size === 'string' ? size : undefined}
      className="michi-state-dot"
      width={px}
      height={px}
      viewBox="0 0 10 10"
      // The live halo reaches past the box so the dot itself lines up with every other state.
      overflow={kind === 'live' ? 'visible' : undefined}
      style={{ flexShrink: 0, display: 'inline-block', verticalAlign: 'middle' }}
    >
      {title && <title>{title}</title>}
      {kind === 'waiting' && <circle cx="5" cy="5" r="3.5" fill="var(--term-accent)" />}
      {kind === 'doing' && (
        <circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--term-mid)" strokeWidth="1.4" />
      )}
      {kind === 'stalled' && (
        <>
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--term-mauve)" strokeWidth="1.4" />
          <path d="M5 1.5 A3.5 3.5 0 0 0 5 8.5 Z" fill="var(--term-mauve)" />
        </>
      )}
      {kind === 'done' && (
        <path
          d="M2.4 5.3 L4.2 7.1 L7.6 3.3"
          fill="none"
          stroke="var(--term-digest)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {kind === 'agent-done' && (
        <circle
          cx="5"
          cy="5"
          r="3.5"
          fill="none"
          stroke="var(--term-digest)"
          strokeWidth="1.4"
          strokeDasharray="1.6 1.4"
        />
      )}
      {/* Faint, yet a non-text glyph still reads at ≥3:1 on bg, surface and alt in every palette (--term-faint's contract). */}
      {kind === 'idea' && <circle cx="5" cy="5" r="2.5" fill="var(--term-faint)" />}
      {kind === 'running' && (
        // Three quarters of a ring (circumference ≈ 22), turning.
        <circle
          className="michi-state-dot__spin"
          cx="5"
          cy="5"
          r="3.5"
          fill="none"
          stroke="var(--term-select)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeDasharray="16.5 22"
        />
      )}
      {kind === 'live' && (
        <>
          <circle cx="5" cy="5" r="6.2" fill="var(--term-accent-f)" />
          <circle cx="5" cy="5" r="3.5" fill="var(--term-accent)" />
        </>
      )}
      {kind === 'read-failed' && <circle cx="5" cy="5" r="3.5" fill="var(--term-danger)" />}
    </svg>
  );
}
