import React, { useId } from 'react';

/**
 * One titled group of settings: an h2 with an optional status on the right,
 * an optional intro, then rows. Consecutive sections are separated by a rule
 * (Settings.css), so a page reads as one list of peers under its h1. On a
 * phone the rows sit in a card under the title.
 */
export function SettingsSection({ title, aside, intro, className, children }: {
  title: string;
  /** Right of the title: a short status ("Off", "Connected"). */
  aside?: React.ReactNode;
  /** Under the title; a string or a few paragraphs. */
  intro?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className={className ? `settings-section ${className}` : 'settings-section'} aria-labelledby={id}>
      <div className="settings-section__head">
        <h2 id={id} className="settings-section__title">{title}</h2>
        {aside != null && aside !== false && <div className="settings-section__aside">{aside}</div>}
      </div>
      {intro != null && <div className="settings-section__intro">{typeof intro === 'string' ? <p>{intro}</p> : intro}</div>}
      {React.Children.toArray(children).length > 0 && <div className="settings-section__body">{children}</div>}
    </section>
  );
}

/**
 * A setting: its name and description on the left, its control on the
 * right (under the name when the section is narrow). `children` span the
 * full width below, for a radio list or notes about the control.
 */
export function SettingsRow({ label, labelFor, labelId, description, control, children }: {
  label: React.ReactNode;
  /** Renders the name as a <label> for this control id. */
  labelFor?: string;
  /** For a group (radiogroup, fieldset) labelled by the name. */
  labelId?: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const name = labelFor
    ? <label className="settings-row__label" htmlFor={labelFor} id={labelId}>{label}</label>
    : <div className="settings-row__label" id={labelId}>{label}</div>;
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        {name}
        {description != null && description !== false && <div className="settings-row__desc">{description}</div>}
      </div>
      {control != null && control !== false && <div className="settings-row__control">{control}</div>}
      {children != null && children !== false && <div className="settings-row__body">{children}</div>}
    </div>
  );
}
