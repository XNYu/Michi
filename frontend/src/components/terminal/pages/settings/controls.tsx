import React from 'react';
import { Row as ClickableRow } from '../../primitives';
import { Switch } from '../../../ui/controls';

export function Row({
  k,
  label,
  children,
}: {
  k: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '12px 0',
        borderBottom: '1px solid var(--term-line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 13,
            color: 'var(--term-fg)',
            fontWeight: 600,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--term-faint)',
            fontFamily: 'var(--ui-font)',
          }}
        >
          {k}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}

export function Radio({
  opts,
  value,
  onChange,
}: {
  opts: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
      {opts.map((o, i) => {
        const sel = o === value;
        return (
          <ClickableRow
            key={o}
            active={sel}
            onClick={() => onChange(o)}
            style={{
              padding: '8px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
              borderBottom: i < opts.length - 1 ? '1px solid var(--term-line)' : 'none',
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                border: `1px solid ${sel ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--term-surface-glass)',
              }}
            >
              {sel && <span style={{ width: 6, height: 6, background: 'var(--term-accent)' }} />}
            </span>
            <span
              style={{
                fontSize: 11.5,
                fontFamily: 'var(--ui-font)',
                color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
                fontWeight: sel ? 600 : 400,
              }}
            >
              {o}
            </span>
          </ClickableRow>
        );
      })}
    </div>
  );
}

export function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <ClickableRow
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 6px',
        margin: '0 -6px',
      }}
      onClick={() => onChange(!on)}
    >
      <Switch on={on} onChange={onChange} aria-label={label} />
      <span style={{ fontSize: 11.5, color: 'var(--term-mid)', fontFamily: 'var(--ui-font)' }}>
        {label}
      </span>
    </ClickableRow>
  );
}
