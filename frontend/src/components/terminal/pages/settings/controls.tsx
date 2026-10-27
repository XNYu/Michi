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
            fontSize: 'var(--fs-lg)',
            color: 'var(--term-fg)',
            fontWeight: 600,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 'var(--fs-xs)',
            color: 'var(--term-muted)',
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

export interface RadioOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

/** Native inputs supply Tab, Space and arrow-key behavior; labels keep the full row clickable. */
export function Radio<T extends string>({
  opts,
  value,
  onChange,
  label,
}: {
  opts: ReadonlyArray<T | RadioOption<T>>;
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  const name = React.useId();
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
      {opts.map((option, i) => {
        const o = typeof option === 'string' ? { value: option, label: option } : option;
        const sel = o.value === value;
        return (
          <label key={o.value} className={`t-row-hover${sel ? ' is-active' : ''}`} style={{
            position: 'relative', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10,
            background: sel ? 'var(--term-alt)' : 'var(--term-surface)', cursor: 'pointer',
            borderBottom: i < opts.length - 1 ? '1px solid var(--term-line)' : 'none',
          }}>
            <input type="radio" aria-label={o.label} name={name} value={o.value} checked={sel} onChange={() => onChange(o.value)}
              style={{ appearance: 'none', margin: 0, width: 12, height: 12, flexShrink: 0,
                border: `1px solid ${sel ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                background: sel ? 'var(--term-accent)' : 'var(--term-surface-glass)',
                boxShadow: sel ? 'inset 0 0 0 2px var(--term-surface)' : undefined, cursor: 'pointer' }}
              aria-describedby={o.description ? `${name}-${i}-description` : undefined} />
            <span>
              <span style={{ fontSize: 'var(--fs-md)', fontFamily: 'var(--ui-font)', color: sel ? 'var(--term-fg)' : 'var(--term-mid)', fontWeight: sel ? 600 : 400 }}>{o.label}</span>
              {o.description && <span id={`${name}-${i}-description`} style={{ display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginTop: 2 }}>{o.description}</span>}
            </span>
          </label>
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
      <span style={{ fontSize: 'var(--fs-md)', color: 'var(--term-mid)', fontFamily: 'var(--ui-font)' }}>
        {label}
      </span>
    </ClickableRow>
  );
}
