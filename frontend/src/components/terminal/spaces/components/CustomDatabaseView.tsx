import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PageComponentSource, PageComponentVersionSource, PageDatabase, PageDatabaseView } from 'michi-shared';
import { readPageComponent, type ComponentHost } from '../../../../services/api/pageComponents';
import { applyView } from '../../content/db/dbModel';
import { pageDatabaseForMichiView } from '../../content/db/nativeDatabaseAdapter';
import { SandboxFrame } from './SandboxFrame';
import { ComponentSourceAttribution } from './ComponentSourceAttribution';
import { useComponentCapability } from './useComponentCapability';
import { subscribePageChanges } from '../../../../state/pages/pageEvents';
import './components.css';

function isMissingComponentVersion(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const failure = cause as { status?: unknown; code?: unknown; message?: unknown };
  return failure.status === 401 || failure.status === 403 || (failure.status === 404 && failure.code === 'not_found');
}

export interface CustomDatabaseViewProps {
  database: PageDatabase;
  view: PageDatabaseView;
  workspaceId: string;
  connectionId: string;
  onAskDraft?: (draft: string) => void;
  onNavigatePage?: (pageId: string) => void;
  onOpenSource?: (source: PageComponentSource) => void | boolean | Promise<void | boolean>;
  readOnly?: boolean;
}

/** The view receives the current native row/column snapshot; its capability can request row-only writes. */
export function CustomDatabaseView(props: CustomDatabaseViewProps) {
  return <CustomDatabaseViewContent key={JSON.stringify([props.connectionId, props.workspaceId, props.database.id, props.view.id, props.view.config.componentId])} {...props} />;
}

function CustomDatabaseViewContent({ database, view, workspaceId, connectionId, onAskDraft, onNavigatePage, onOpenSource, readOnly = false }: CustomDatabaseViewProps) {
  const componentId = view.config.componentId ?? '';
  const version = view.config.pinnedVersion;
  const host = useMemo<ComponentHost>(() => ({ kind: 'database_view', databaseId: database.id, viewId: view.id }), [database.id, view.id]);
  const props = useMemo(() => view.config.props ?? {}, [view.config.props]);
  const data = useMemo(() => {
    const michiDatabase = pageDatabaseForMichiView(database);
    const groups = applyView(michiDatabase, view.config);
    return {
      database: { id: database.id, title: database.title, revision: database.revision },
      columns: database.columns,
      groups: groups.map(group => ({ key: group.key, label: group.label, rows: group.rows })),
      rows: groups.flatMap(group => group.rows),
    };
  }, [database, view.config]);
  const [source, setSource] = useState<{ code: string; name: string; version: number; provenance: PageComponentVersionSource } | null>(null);
  const [displayedSource, setDisplayedSource] = useState<typeof source>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    let live = true;
    let reading = false;
    let readAgain = false;
    let unavailable = false;
    if (!componentId) { setError('This custom view has no component selected.'); return () => { live = false; }; }
    const load = async () => {
      if (reading) { readAgain = true; return; }
      reading = true;
      try {
        const result = await readPageComponent(componentId, workspaceId, connectionId, version);
        if (!live) return;
        if (!result.component?.enabled) { setSource(null); setError('This component is disabled or unavailable.'); return; }
        unavailable = false;
        setError(null);
        setSource(previous => previous?.version === result.version.version && previous.code === result.version.code ? previous
          : { code: result.version.code, name: result.component!.name, version: result.version.version, provenance: result.version.source });
      } catch (cause) {
        if (live) {
          if (isMissingComponentVersion(cause)) { unavailable = true; setSource(null); }
          setError(cause instanceof Error ? cause.message : 'Custom view unavailable');
        }
      } finally { reading = false; if (live && readAgain && !unavailable) { readAgain = false; void load(); } }
    };
    const unsubscribe = subscribePageChanges({ backendConnectionId: connectionId, workspaceId, databaseId: database.id }, changed => {
      if (!changed.componentId || changed.componentId === componentId) void load();
    });
    void load();
    const timer = window.setInterval(() => { if (!unavailable) void load(); }, 10_000);
    return () => { live = false; unsubscribe(); window.clearInterval(timer); };
  }, [componentId, connectionId, database.id, version, workspaceId]);
  const { state, call } = useComponentCapability({ connectionId, workspaceId, componentId, version: source?.version ?? version ?? 0, host, props, bindingKey: [view.config, view.edit], enabled: source !== null && !stopped && !readOnly });
  const stop = useCallback(() => setStopped(true), []);
  if (readOnly) return <div className="page-component-fallback" role="status"><strong>{source?.name ?? 'Custom view'}</strong><p>This database is read-only, so the component is paused.</p></div>;
  if (stopped) return <div className="page-component-fallback" role="status"><strong>{source?.name ?? 'Custom view'}</strong><p>This component was stopped. Reopen the view to run it again.</p></div>;
  if (!source && error) return <div className="page-component-fallback" role="status"><strong>Custom view unavailable</strong><p>{error}</p></div>;
  if (!source) return <div className="page-component-loading" role="status">Loading custom view…</div>;
  const displayed = displayedSource ?? source;
  return <section className="page-component-host" aria-label={`${displayed.name} custom database view`} data-component-id={componentId} data-component-version={displayed.version}>
    <div className="page-component-host-label">{displayed.name} · v{displayed.version}<ComponentSourceAttribution source={displayed.provenance} onOpenSource={onOpenSource} /></div>
    <SandboxFrame stable onPresented={() => setDisplayedSource(source)} scopeKey={JSON.stringify(host)} candidateReady={Boolean(state?.capability)} connectionId={connectionId} name={source.name} code={source.code} versionKey={source.version} initialHeight={view.config.height} props={props} data={data} capability={state?.capability ? { id: state.capabilityId, token: state.capability, call } : undefined} onAskDraft={onAskDraft} onNavigate={onNavigatePage} onStop={stop} />
    {error && <p className="page-component-notice" role="status">The update is unavailable. {error}</p>}
  </section>;
}
