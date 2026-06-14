import React from 'react';
import { kbd } from '../lib/platform';

export default function EmptyThreads() {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        color: 'var(--term-muted)',
        fontFamily: 'var(--ui-font)',
      }}
    >
      <div style={{ fontSize: 18, color: 'var(--term-fg)', marginBottom: 8 }}>
        ▂ all threads archived
      </div>
      <div style={{ fontSize: 12, marginBottom: 16 }}>
        Start a new thread or unarchive one.
      </div>
      <button
        onClick={() => window.dispatchEvent(new CustomEvent('michi:goto-home'))}
        style={{
          padding: '6px 14px',
          border: '1px solid var(--term-accent)',
          color: 'var(--term-accent)',
          background: 'transparent',
          fontFamily: 'var(--ui-font)',
          cursor: 'pointer',
        }}
      >
        + new thread ({kbd('mod', 'T')})
      </button>
    </div>
  );
}
