import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { PageBlock, PageComponentSource, PageComponentVersionSource } from 'michi-shared';
import { readPageComponent, type ComponentHost } from '../../../../services/api/pageComponents';
import { subscribePageChanges } from '../../../../state/pages/pageEvents';
import { SandboxFrame } from './SandboxFrame';
import { ComponentSourceAttribution } from './ComponentSourceAttribution';
import { useComponentCapability } from './useComponentCapability';
import './components.css';

function isMissingComponentVersion(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const failure = cause as { status?: unknown; code?: unknown; message?: unknown };
  return failure.status === 401 || failure.status === 403 || (failure.status === 404 && failure.code === 'not_found');
}

export interface CustomBlockProps {
  block: Extract<PageBlock, { type: 'component' }>;
  pageId: string;
  workspaceId: string;
  connectionId: string;
  onAskDraft?: (draft: string) => void;
  onNavigatePage?: (pageId: string) => void;
  onOpenSource?: (source: PageComponentSource) => void | boolean | Promise<void | boolean>;
  readOnly?: boolean;
}

export function CustomBlock(props: CustomBlockProps) {
  return <CustomBlockContent key={JSON.stringify([props.connectionId, props.workspaceId, props.pageId, props.block.id, props.block.componentId])} {...props} />;
}

function CustomBlockContent({ block, pageId, workspaceId, connectionId, onAskDraft, onNavigatePage, onOpenSource, readOnly = false }: CustomBlockProps) {
  const host = useMemo<ComponentHost>(() => ({ kind: 'page_block', pageId, blockId: block.id }), [block.id, pageId]);
  const [source, setSource] = useState<{ code: string; name: string; version: number; provenance: PageComponentVersionSource } | null>(null);
  const [displayedSource, setDisplayedSource] = useState<typeof source>(null);
  const [data, setData] = useState<unknown>(null);
  const [dataVersion, setDataVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const pauseCapabilityRef = React.useRef<(() => void) | null>(null);
  useEffect(() => {
    let live = true;
    let reading = false;
    let readAgain = false;
    let unavailable = false;
    const load = async () => {
      if (reading) { readAgain = true; return; }
      reading = true;
      try {
        const result = await readPageComponent(block.componentId, workspaceId, connectionId, block.pinnedVersion);
        if (!live) return;
        if (!result.component?.enabled) { setSource(null); setSourceError('This component is disabled or unavailable.'); return; }
        unavailable = false;
        setSourceError(null);
        setSource(previous => previous?.version === result.version.version && previous.code === result.version.code ? previous
          : { code: result.version.code, name: result.component!.name, version: result.version.version, provenance: result.version.source });
      } catch (cause) {
        if (live) {
          if (isMissingComponentVersion(cause)) {
            unavailable = true;
            pauseCapabilityRef.current?.();
            setSource(null);
          }
          setSourceError(cause instanceof Error ? cause.message : 'This component version is unavailable');
        }
      } finally { reading = false; if (live && readAgain && !unavailable) { readAgain = false; void load(); } }
    };
    const unsubscribe = subscribePageChanges({ backendConnectionId: connectionId, workspaceId, pageId }, changed => {
      if (!changed.componentId || changed.componentId === block.componentId) void load();
    });
    void load();
    const timer = window.setInterval(() => { if (!unavailable) void load(); }, 10_000);
    return () => { live = false; unsubscribe(); window.clearInterval(timer); };
  }, [block.componentId, block.pinnedVersion, connectionId, pageId, workspaceId]);
  const props = useMemo(() => block.props, [block.props]);
  const capability = useComponentCapability({ connectionId, workspaceId, componentId: block.componentId, version: source?.version ?? block.pinnedVersion ?? 0, host, props, bindingKey: [block.rev, block.edit], enabled: source !== null && !stopped && !readOnly });
  pauseCapabilityRef.current = capability.pause;
  const { state, call } = capability;
  const stop = useCallback(() => setStopped(true), []);
  const databaseIds = useMemo(() => {
    const values = [props.databaseId, ...(Array.isArray(props.databaseIds) ? props.databaseIds : [])];
    return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].slice(0, 20);
  }, [props]);
  useEffect(() => {
    if (!source || !state?.capability) return;
    let live = true;
    let reading = false;
    let refreshAgain = false;
    const refresh = async () => {
      if (reading) { refreshAgain = true; return; }
      reading = true;
      try {
        const [hostData, ...databases] = await Promise.all([
          call('read.host', []),
          ...databaseIds.map(databaseId => call('read.database', [databaseId])),
        ]);
        if (!live) return;
        setData({ ...(hostData && typeof hostData === 'object' ? hostData : { host: hostData }), databases: Object.fromEntries(databaseIds.map((databaseId, index) => [databaseId, databases[index]])) });
        setDataVersion(source.version);
        setError(null);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : 'Could not read this component host');
      } finally {
        reading = false;
        if (live && refreshAgain) { refreshAgain = false; void refresh(); }
      }
    };
    const unsubscribe = subscribePageChanges({ backendConnectionId: connectionId, workspaceId, pageId }, changed => {
      if (changed.pageId === pageId || (changed.databaseId && databaseIds.includes(changed.databaseId))) void refresh();
    });
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    void refresh();
    return () => { live = false; unsubscribe(); window.clearInterval(timer); };
  }, [call, connectionId, databaseIds, pageId, source, state?.capability, workspaceId]);
  if (readOnly) return <div className="page-component-fallback" role="status"><strong>{source?.name ?? 'Component'}</strong><p>This page is read-only, so the component is paused.</p></div>;
  if (stopped) return <div className="page-component-fallback" role="status"><strong>{source?.name ?? 'Component'}</strong><p>This component was stopped. Reopen the page to run it again.</p></div>;
  if ((!source || data === null) && (sourceError || error)) return <div className="page-component-fallback" role="status"><strong>{source?.name ?? 'Unavailable component'}</strong><p>{sourceError ?? error}</p></div>;
  if (!source || data === null) return <div className="page-component-loading" role="status">Loading component…</div>;
  const displayed = displayedSource ?? source;
  return <div className="page-component-host" data-component-id={block.componentId} data-component-version={displayed.version}>
    <div className="page-component-host-label">{displayed.name} · v{displayed.version}<ComponentSourceAttribution source={displayed.provenance} onOpenSource={onOpenSource} /></div>
    <SandboxFrame stable onPresented={() => setDisplayedSource(source)} scopeKey={JSON.stringify(host)} candidateReady={Boolean(state?.capability) && dataVersion === source.version} connectionId={connectionId} name={source.name} code={source.code} versionKey={source.version} initialHeight={block.height} props={props} data={data} capability={state?.capability ? { id: state.capabilityId, token: state.capability, call } : undefined} onAskDraft={onAskDraft} onNavigate={onNavigatePage} onStop={stop} />
    {(sourceError || error) && <p className="page-component-notice" role="status">The update is unavailable. {sourceError ?? error}</p>}
  </div>;
}
