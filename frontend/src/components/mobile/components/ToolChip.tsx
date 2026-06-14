import React from 'react';
import type { ToolCallState } from '../../../state/chatTypes';

interface Props {
  call: ToolCallState;
}

/** Inline tool-call chip. Tap to expand into a JSON modal. */
export default function ToolChip({ call }: Props) {
  const [expanded, setExpanded] = React.useState(false);

  // Status normalisation: backend uses lots of strings; collapse to ok/err/running.
  const status = (() => {
    const s = call.status?.toLowerCase() ?? '';
    if (s.includes('error') || s.includes('fail')) return 'err';
    if (s.includes('done') || s.includes('success') || s.includes('completed')) return 'ok';
    return 'running';
  })();

  const glyph = status === 'ok' ? '✓' : status === 'err' ? '✗' : '◐';

  return (
    <>
      <span
        className="m-tool-chip"
        data-status={status}
        onClick={() => setExpanded(true)}
        title={call.title}
      >
        <span style={{ flexShrink: 0 }}>{glyph}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {call.title}
        </span>
      </span>
      {expanded && (
        <div className="m-sheet-scrim" onClick={() => setExpanded(false)}>
          <div
            className="m-sheet"
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: '70vh', overflowY: 'auto' }}
          >
            <div style={{ padding: '14px 18px', fontSize: 13, fontWeight: 600 }}>
              {call.title}
            </div>
            <div style={{ padding: '0 18px 14px', fontSize: 11.5, color: 'var(--term-muted)' }}>
              <div>kind: {call.kind ?? '—'}</div>
              <div>status: {call.status}</div>
              {call.detail && <div>purpose: {call.detail}</div>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
