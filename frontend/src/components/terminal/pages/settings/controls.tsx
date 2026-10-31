import React from 'react';
import { Row as ClickableRow } from '../../primitives';
import { Switch } from '../../../ui/controls';
import '../Settings.css';

/**
 * A labelled setting whose control sits under its name. `k` is the
 * preference key; Settings search finds a setting by it, so the page does
 * not show it.
 */
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
    <div className="settings-field" data-setting-key={k}>
      <div className="settings-field__head">
        <div className="settings-field__label">{label}</div>
      </div>
      <div className="settings-field__body">{children}</div>
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
    <div role="radiogroup" aria-label={label} className="settings-radio">
      {opts.map((option, i) => {
        const o = typeof option === 'string' ? { value: option, label: option } : option;
        const sel = o.value === value;
        return (
          <label key={o.value} className={`settings-radio__option t-row-hover${sel ? ' is-active' : ''}`}>
            <input type="radio" aria-label={o.label} name={name} value={o.value} checked={sel} onChange={() => onChange(o.value)}
              className="settings-radio__input"
              aria-describedby={o.description ? `${name}-${i}-description` : undefined} />
            <span>
              <span className="settings-radio__label">{o.label}</span>
              {o.description && <span id={`${name}-${i}-description`} className="settings-radio__description">{o.description}</span>}
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
    <ClickableRow className="settings-toggle" onClick={() => onChange(!on)}>
      <Switch on={on} onChange={onChange} aria-label={label} />
      <span className="settings-toggle__label">{label}</span>
    </ClickableRow>
  );
}
