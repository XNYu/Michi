import React from 'react';

export default function TerminalStatusLine({
  left,
  right,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <div
      className="terminal-status-line"
      style={{
        height: 22,
        flexShrink: 0,
        background: 'var(--term-status-bg, var(--term-bg))',
        color: 'var(--term-status-fg, var(--term-mid))',
        fontFamily: 'var(--ui-font)',
        fontSize: 10.5,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        letterSpacing: '.04em',
        borderRadius: 'var(--term-status-radius, 0px)',
      }}
    >
      <span>{left}</span>
      <div style={{ flex: 1 }} />
      <span style={{ color: 'var(--term-faint)' }}>{right}</span>
    </div>
  );
}
