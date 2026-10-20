import React from 'react';
import type { DeskThreadState } from 'michi-shared';
import { CheckIcon } from '../../icons';
import { stateLabel } from './format';

/**
 * Status is a shape and a color together. Stalled is the half disc in
 * --term-select (amber), the same token Michi uses while a reply is streaming.
 */
export function StatusMark({
  state,
  doneBy,
  size = 8,
}: {
  state: DeskThreadState;
  doneBy?: 'user' | 'agent';
  size?: number;
}) {
  if (state === 'done' && doneBy === 'agent') {
    return (
      <span role="img" aria-label="Agent says done" data-shape="dashed" style={rowStyle}>
        <Disc size={size} shape="dashed" color="var(--term-digest)" />
        <span style={agentLabel}>Agent says</span>
      </span>
    );
  }
  if (state === 'done') {
    return (
      <span role="img" aria-label="Done" data-shape="check" style={{ color: 'var(--term-digest)', display: 'inline-flex' }}>
        <CheckIcon size={size + 4} />
      </span>
    );
  }
  const shape = state === 'waiting' ? 'solid' : state === 'doing' ? 'ring' : state === 'stalled' ? 'half' : 'square';
  const color = state === 'waiting'
    ? 'var(--term-accent)'
    : state === 'doing'
      ? 'var(--term-mid)'
      : state === 'stalled'
        ? 'var(--term-select)'
        : 'var(--term-line)';
  return (
    <span role="img" aria-label={stateLabel(state)} data-shape={shape} style={{ display: 'inline-flex' }}>
      <Disc size={state === 'idea' ? Math.max(6, size - 2) : size} shape={shape} color={color} />
    </span>
  );
}

function Disc({ size, shape, color }: { size: number; shape: 'solid' | 'ring' | 'half' | 'dashed' | 'square'; color: string }) {
  const common: React.CSSProperties = {
    width: size,
    height: size,
    display: 'inline-block',
    boxSizing: 'border-box',
    flexShrink: 0,
  };
  if (shape === 'square') {
    return <span style={{ ...common, background: color, borderRadius: 'var(--ui-radius-sm)' }} />;
  }
  if (shape === 'solid') {
    return <span style={{ ...common, background: color, borderRadius: '50%' }} />;
  }
  if (shape === 'half') {
    return (
      <span
        style={{
          ...common,
          borderRadius: '50%',
          border: `1.5px solid ${color}`,
          background: `linear-gradient(90deg, ${color} 0 50%, transparent 50% 100%)`,
        }}
      />
    );
  }
  return (
    <span
      style={{
        ...common,
        borderRadius: '50%',
        border: `1.5px ${shape === 'dashed' ? 'dashed' : 'solid'} ${color}`,
        background: 'transparent',
      }}
    />
  );
}

const rowStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6 };
const agentLabel: React.CSSProperties = {
  fontSize: 'var(--fs-2xs)',
  letterSpacing: 'var(--ls-caps)',
  textTransform: 'uppercase',
  color: 'var(--term-digest)',
};
