import React from 'react';

/**
 * A task's status as a glyph, drawn apart from conversation dots: To do a
 * dashed ring, In progress a ring, Waiting on you a filled dot, Done a check.
 * A status a person added is a faint ring.
 */
export function TaskStatusGlyph({ status, size = 10 }: { status: string; size?: number }) {
  const c = size / 2;
  const r = size / 2 - 1;
  return (
    <svg className="michi-task-status" data-status={status} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {status === 'todo' && <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.6" />}
      {status === 'doing' && <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1.4" />}
      {status === 'waiting' && <circle cx={c} cy={c} r={r} fill="currentColor" />}
      {status === 'done' && (
        <path d={`M${size * 0.2} ${size * 0.55} L${size * 0.42} ${size * 0.76} L${size * 0.82} ${size * 0.28}`}
          fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
      {!['todo', 'doing', 'waiting', 'done'].includes(status) && <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeWidth="1" opacity="0.6" />}
    </svg>
  );
}
