import React from 'react';
import type { MichiThreadState } from 'michi-shared';
import { ThreadStateDot } from './ThreadStateDot';
import './michi.css';

/** Michi's section caption: optional state glyph, uppercase label, mono count, right slot. */
export function MichiSectionLabel({
  state,
  doneBy,
  label,
  count,
  right,
  dotSize = 8,
}: {
  state?: MichiThreadState;
  doneBy?: 'user' | 'agent';
  label: string;
  count?: number;
  right?: React.ReactNode;
  /** The glyph's size; Home's section headers use `lg`. */
  dotSize?: number | 'lg';
}) {
  return (
    <div className="michi-section-label">
      {state && (
        <span className="michi-section-label__dot" aria-hidden="true">
          <ThreadStateDot state={state} doneBy={doneBy} size={dotSize} />
        </span>
      )}
      <span className="michi-section-label__text">{label}</span>
      {count !== undefined && <span className="michi-section-label__count">{count}</span>}
      {right && <span className="michi-section-label__right">{right}</span>}
    </div>
  );
}
