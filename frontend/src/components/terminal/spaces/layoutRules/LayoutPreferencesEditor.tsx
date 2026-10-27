import React from 'react';
import { PAGE_LAYOUT_PREFERENCES_LIMIT, type PageLayoutPreferences } from 'michi-shared';
import { fetchLayoutPreferences, saveLayoutPreferences } from '../../../../services/api/spacesHome';
import { PageApiError } from '../../../../services/api/pages';
import { notifyPageChanged, type PageEventIdentity } from '../../../../state/pages/pageEvents';
import { Button } from '../../../ui/controls';
import './layoutRules.css';

type Draft = { text: string; baseRevision: number };
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'Could not save layout preferences.';

/** One page-local document. Background reads never replace a draft or move focus. */
export function LayoutPreferencesEditor({ pageId, backendConnectionId, readOnly = false }: {
  pageId: string; backendConnectionId: string; readOnly?: boolean;
}) {
  // Key the inner editor by page and connection so late reads/writes from a page
  // that was closed can never change a different page's draft.
  return <PreferencesDocument key={`${backendConnectionId}:${pageId}`} pageId={pageId} backendConnectionId={backendConnectionId} readOnly={readOnly} />;
}

function PreferencesDocument({ pageId, backendConnectionId, readOnly }: {
  pageId: string; backendConnectionId: string; readOnly: boolean;
}) {
  const [document, setDocument] = React.useState<PageLayoutPreferences | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const alive = React.useRef(false);
  const saving = React.useRef(false);
  const controller = React.useRef<AbortController | null>(null);
  const hintId = React.useId();

  const accept = React.useCallback((next: PageLayoutPreferences) => {
    setDocument(previous => previous && previous.revision > next.revision ? previous : next);
  }, []);

  const refresh = React.useCallback(async () => {
    controller.current?.abort();
    const pending = new AbortController();
    controller.current = pending;
    try {
      const next = await fetchLayoutPreferences(pageId, backendConnectionId, pending.signal);
      if (!alive.current || pending.signal.aborted) return;
      accept(next);
      setReadError(null);
    } catch (cause) {
      if (!alive.current || pending.signal.aborted) return;
      setReadError(errorMessage(cause));
    }
  }, [accept, backendConnectionId, pageId]);

  React.useEffect(() => {
    alive.current = true;
    void refresh();
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<PageEventIdentity>).detail;
      if (detail?.backendConnectionId === backendConnectionId && (!detail.pageId || detail.pageId === pageId)) void refresh();
    };
    window.addEventListener('michi:page-changed', onChanged);
    return () => {
      alive.current = false;
      controller.current?.abort();
      window.removeEventListener('michi:page-changed', onChanged);
    };
  }, [backendConnectionId, pageId, refresh]);

  const changed = !!document && draft !== null && draft.text.trim() !== document.text;
  const conflict = changed && draft!.baseRevision !== document!.revision;
  const save = async () => {
    if (readOnly || saving.current || !document || !draft || !changed || conflict) return;
    const sent = draft;
    saving.current = true;
    setBusy(true); setSaveError(null); setSaved(false);
    controller.current?.abort();
    try {
      const next = await saveLayoutPreferences(pageId, { text: sent.text, expectedRevision: sent.baseRevision }, backendConnectionId);
      if (!alive.current) return;
      accept(next);
      setDraft(current => current?.text === sent.text ? null : current && { ...current, baseRevision: next.revision });
      setSaved(true);
      notifyPageChanged({ backendConnectionId, pageId });
    } catch (cause) {
      if (!alive.current) return;
      setSaveError(errorMessage(cause));
      if (cause instanceof PageApiError && cause.status === 409) await refresh();
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };

  return <div className="layout-preferences-editor">
    <p id={hintId} className="layout-preferences-editor__hint">Describe how to organize this page. The assistant follows these preferences on its next update. They apply only to this page; existing section limits stay in effect.</p>
    {!document && !readError && <p role="status">Loading preferences…</p>}
    {readError && <p role="alert">{readError} <Button size="sm" variant="ghost" onClick={() => void refresh()}>Retry preferences</Button></p>}
    {document && <>
      <textarea className="layout-preferences-editor__input" aria-label="Layout preferences" aria-describedby={hintId}
        rows={6} maxLength={PAGE_LAYOUT_PREFERENCES_LIMIT} readOnly={readOnly}
        placeholder={'For example:\nPut risks first\nKeep the summary short\nShow decisions that need my attention at the top'}
        value={draft?.text ?? document.text}
        onChange={event => {
          const text = event.target.value;
          setDraft(current => ({ text, baseRevision: current?.baseRevision ?? document.revision }));
          setSaved(false); setSaveError(null);
        }} />
      {conflict && <div className="layout-preferences-editor__conflict" role="alert">
        <p>Preferences changed elsewhere. Your draft is kept. Review the latest version before replacing it.</p>
        <details><summary>Latest saved preferences</summary><pre>{document.text || 'No preferences.'}</pre></details>
        <div className="layout-preferences-editor__actions">
          <Button size="sm" disabled={busy || readOnly} onClick={() => { setDraft(null); setSaveError(null); }}>Use latest</Button>
          <Button size="sm" disabled={busy || readOnly} onClick={() => { setDraft(current => current && { ...current, baseRevision: document.revision }); setSaveError(null); }}>Keep my draft</Button>
        </div>
      </div>}
      {!readOnly && <div className="layout-preferences-editor__actions">
        <Button size="sm" variant="primary" disabled={!changed || busy || conflict} onClick={() => void save()}>{busy ? 'Saving…' : 'Save preferences'}</Button>
        {changed && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setDraft(null); setSaveError(null); setSaved(false); }}>Discard edits</Button>}
      </div>}
      {readOnly && <p className="layout-preferences-editor__hint">This page is read-only.</p>}
      {saveError && !conflict && <p role="alert">{saveError}</p>}
      {saved && !changed && <p role="status">Preferences saved.</p>}
    </>}
  </div>;
}
