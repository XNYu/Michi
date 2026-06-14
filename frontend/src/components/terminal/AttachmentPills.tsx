import React from 'react';
import type { MessageAttachment } from '../../state/chatTypes';

interface Props {
  items: MessageAttachment[];
}

export function AttachmentPills({ items }: Props) {
  if (items.length === 0) return null;
  // Mirror the composer's pending-attachment chips (.t-att-chip in index.css)
  // so a file looks identical before and after it's sent.
  return (
    <div className="t-att-chips" style={{ marginBottom: 8 }}>
      {items.map((a, i) => (
        <span
          key={`${a.absPath}-${i}`}
          data-testid="attachment-pill"
          className="t-att-chip"
          title={a.absPath}
        >
          <span style={{ fontSize: 10, opacity: 0.7 }} aria-hidden>📄</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {a.name}
          </span>
        </span>
      ))}
    </div>
  );
}
