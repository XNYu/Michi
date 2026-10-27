import React, { useState } from 'react';
import { PAGE_LAYOUT_RULE_LIMITS, type PageDto } from 'michi-shared';
import { addLayoutRule } from '../../../services/api/spacesHome';
import { notifyPageChanged } from '../../../state/pages/pageEvents';
import { useLayoutRules } from './layoutRules/useLayoutRules';
import { layoutRuleMeta } from './layoutRules/LayoutRulesPopover';
import { LayoutPreferencesEditor } from './layoutRules/LayoutPreferencesEditor';
import { MaintenanceStatus } from './MaintenanceStatus';
import './spaceSettings.css';

const SUGGESTIONS = ['Put risks first', 'Show the next decisions at the top', 'Keep the summary short'];

export function SpaceSettings({ page, connectionId, spaceId, spaceTitle, onBack, onRename, onComponents }: {
  page: PageDto; connectionId: string; spaceId: string; spaceTitle: string;
  onBack(): void; onRename(title: string): Promise<void>; onComponents(): void;
}) {
  const rules = useLayoutRules(page.id, connectionId, true);
  const [name, setName] = useState(page.title);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(null); setSaved(false);
    try { await action(); setSaved(true); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save changes.'); }
    finally { setBusy(false); }
  };
  return <section className="space-settings" aria-label="Page settings">
    <button type="button" className="space-settings__back" onClick={onBack}>← Back to page</button>
    <h1 className="spaces-home__title">{page.title} · Settings</h1>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status" className="spaces-home-muted">Saved</p>}
    <section className="space-settings__section">
      <h2>Name</h2>
      <form className="space-settings__form" onSubmit={event => { event.preventDefault(); if (name.trim()) void run(() => onRename(name.trim())); }}>
        <input aria-label="Page name" maxLength={200} value={name} onChange={event => { setName(event.target.value); setSaved(false); }} />
        <button type="submit" disabled={busy || !name.trim() || name.trim() === page.title}>Save name</button>
      </form>
      <p>This name appears in the sidebar and at the top of the page.</p>
    </section>
    <section className="space-settings__section">
      <h2>Layout preferences</h2>
      <LayoutPreferencesEditor pageId={page.id} backendConnectionId={connectionId} />
    </section>
    <section className="space-settings__section">
      <h2>Layout rules</h2>
      <p>Tell the Meta agent how to organize this page. Rules apply when it next updates the page.</p>
      {rules.error && <p role="alert">{rules.error} <button type="button" onClick={() => rules.refresh({ report: true })}>Retry</button></p>}
      {rules.rules === null ? (!rules.error && <p role="status">Loading rules…</p>) : rules.rules.length ? <ul className="space-settings__rules">{rules.rules.map(rule => <li key={rule.id}>
        <div><span>{rule.text}</span><small>{layoutRuleMeta(rule)}</small></div>
        <button type="button" disabled={busy} aria-label={`Delete rule: ${rule.text}`} onClick={() => void run(() => rules.remove(rule.id))}>Delete</button>
      </li>)}</ul> : <p>No layout rules yet.</p>}
      <form className="space-settings__form" onSubmit={event => {
        event.preventDefault(); if (!text.trim()) return;
        void run(async () => {
          await addLayoutRule(page.id, { text: text.trim() }, connectionId);
          setText(''); notifyPageChanged({ backendConnectionId: connectionId, pageId: page.id }); rules.refresh({ report: true });
        });
      }}>
        <input aria-label="New layout rule" maxLength={PAGE_LAYOUT_RULE_LIMITS.text} placeholder="For example: put risks first" value={text} onChange={event => { setText(event.target.value); setSaved(false); }} />
        <button type="submit" disabled={busy || !text.trim()}>Add rule</button>
      </form>
      <div className="space-settings__suggestions">{SUGGESTIONS.map(suggestion => <button type="button" key={suggestion} onClick={() => setText(suggestion)}>{suggestion}</button>)}</div>
    </section>
    <section className="space-settings__section">
      <h2>Automatic updates</h2>
      <MaintenanceStatus backendConnectionId={connectionId} workspaceId={page.workspaceId} spaceId={spaceId} spaceTitle={spaceTitle} pendingProposals={page.pendingProposals} />
    </section>
    <section className="space-settings__section space-settings__row"><div><h2>Components</h2><p>Browse built-in blocks and manage this workspace’s reusable components.</p></div><button type="button" onClick={onComponents}>Browse components</button></section>
  </section>;
}
