import React from 'react';
import { AgentDefinitionStatus } from 'michi-shared';
import type { AgentDefinitionDtoV1, AgentCapabilityCatalogEntryV1, AgentEnableBlockerV1 } from 'michi-shared';
import type { AgentResourceIdentity, LocatedAgentResource } from '../../../state/agentIdentity';
import { listAgentCapabilities } from '../../../services/api/agents';
import { fetchAgentStatus, fetchRuntimeCatalog, type AgentModelInfo, type AgentProviderInfo, type AgentRuntimeOption } from '../../../services/api/agentRuntime';
import AgentDefinitionForm, {
  createAgentDefinitionFormValue, draftSaveBlocked, outlineButtonStyle,
  validateAgentDefinitionForm, type AgentDefinitionFormValue,
} from './AgentDefinitionForm';
import { catalogKey, type RuntimeFieldCatalog } from './AgentRuntimeProfileFields';

/**
 * Dropdown data for runtime/provider/model. Runtimes come from one
 * /agent/status call; providers+models load lazily per runtime(+provider)
 * through /agent/runtime-catalog and are cached for the editor session.
 */
function useRuntimeFieldCatalog(): RuntimeFieldCatalog | null {
  const [runtimes, setRuntimes] = React.useState<AgentRuntimeOption[] | null>(null);
  const [providersFor, setProvidersFor] = React.useState<Record<string, AgentProviderInfo[] | undefined>>({});
  const [modelsFor, setModelsFor] = React.useState<Record<string, AgentModelInfo[] | undefined>>({});
  const inFlight = React.useRef(new Set<string>());
  React.useEffect(() => {
    let cancelled = false;
    fetchAgentStatus()
      .then((status) => { if (!cancelled) setRuntimes(status.availableRuntimes ?? []); })
      .catch(() => { if (!cancelled) setRuntimes(null); });
    return () => { cancelled = true; };
  }, []);
  const request = React.useCallback((runtimeId: string, providerId: string) => {
    const key = catalogKey(runtimeId, providerId);
    if (!runtimeId || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    fetchRuntimeCatalog(runtimeId, providerId || undefined)
      .then(({ providers, models }) => {
        setProvidersFor((current) => current[runtimeId] ? current : { ...current, [runtimeId]: providers });
        setModelsFor((current) => ({ ...current, [key]: models }));
      })
      .catch(() => { inFlight.current.delete(key); });
  }, []);
  return React.useMemo(
    () => (runtimes === null ? null : { runtimes, providersFor, modelsFor, request }),
    [runtimes, providersFor, modelsFor, request],
  );
}

interface Props {
  definition?: LocatedAgentResource<AgentDefinitionDtoV1> | null;
  initialScope?: 'global' | 'workspace';
  workspaceId?: string | null;
  busy?: boolean;
  error?: string | null;
  /** Structured enable blockers from the backend (AgentEnableBlockedError). */
  blockers?: AgentEnableBlockerV1[] | null;
  onSaveDraft: (value: AgentDefinitionFormValue) => void | Promise<void>;
  onEnable: (value: AgentDefinitionFormValue) => void | Promise<void>;
  onDisable?: (identity: AgentResourceIdentity) => void | Promise<void>;
  onDuplicate?: (identity: AgentResourceIdentity) => void | Promise<void>;
  onDelete?: (identity: AgentResourceIdentity) => void | Promise<void>;
  onCancel?: () => void;
}

export default function AgentEditorPage({
  definition, initialScope = 'workspace', workspaceId = null, busy = false, error, blockers = null,
  onSaveDraft, onEnable, onDisable, onDuplicate, onDelete, onCancel,
}: Props) {
  const [value, setValue] = React.useState(() => createAgentDefinitionFormValue(definition?.value, initialScope, workspaceId));
  const [submitting, setSubmitting] = React.useState<string | null>(null);
  const [capabilities, setCapabilities] = React.useState<AgentCapabilityCatalogEntryV1[] | null>(null);
  const runtimeCatalog = useRuntimeFieldCatalog();
  React.useEffect(() => setValue(createAgentDefinitionFormValue(definition?.value, initialScope, workspaceId)), [definition?.backendConnectionId, definition?.value.id, initialScope, workspaceId]);
  const effectiveWorkspaceId = definition?.value.workspaceId ?? workspaceId;
  React.useEffect(() => {
    // Catalog is advisory: on failure the form falls back to manual refs.
    const controller = new AbortController();
    listAgentCapabilities(effectiveWorkspaceId, controller.signal)
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
    return () => controller.abort();
  }, [effectiveWorkspaceId]);
  const errors = React.useMemo(() => validateAgentDefinitionForm(value), [value]);
  const identity = definition ? { backendConnectionId: definition.backendConnectionId, id: definition.value.id } : null;
  const status = definition?.value.status ?? AgentDefinitionStatus.Draft;
  const blocked = busy || submitting !== null;
  const invoke = async (label: string, action: () => void | Promise<void>) => {
    setSubmitting(label);
    try { await action(); } finally { setSubmitting(null); }
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--term-page-bg, var(--term-bg))', color: 'var(--term-fg)' }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '28px 56px 40px' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 20, marginBottom: 28 }}>
        <div>
          <div style={{ color: 'var(--term-muted)', fontFamily: 'var(--mono-font)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' }}>{definition ? 'Edit custom agent' : 'New custom agent'}</div>
          <h1 style={{ margin: '6px 0 4px', fontFamily: 'var(--ui-font)', fontSize: 34, lineHeight: 1.1, fontWeight: 500 }}>{value.name.trim() || 'Untitled Agent'}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 11 }}>
            <ScopeBadge scope={value.scope} />
            <span>{status}</span>
          </div>
        </div>
        {onCancel && <button type="button" onClick={onCancel} style={outlineButtonStyle}>close</button>}
      </header>

      {blockers && blockers.length > 0 && (
        <div role="alert" data-testid="enable-blockers" style={{ border: '1px solid var(--term-select)', background: 'var(--term-select-f)', padding: '9px 11px', marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--term-fg)', fontFamily: 'var(--ui-font)' }}>
            Cannot enable yet — {blockers.length} condition{blockers.length === 1 ? '' : 's'}
          </div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--term-mid)', fontFamily: 'var(--ui-font)', fontSize: 11.5 }}>
            {blockers.map((blocker, index) => (
              <li key={index}>
                {blocker.ref ? <span style={{ fontFamily: 'var(--mono-font)', fontSize: 11, color: 'var(--term-fg)' }}>{blocker.ref}</span> : null}
                {blocker.ref ? ' — ' : ''}{blocker.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (!blockers || blockers.length === 0) && <div role="alert" style={{ border: '1px solid var(--danger, var(--term-error))', color: 'var(--danger, var(--term-error))', padding: 10, marginBottom: 16, fontFamily: 'var(--ui-font)', fontSize: 12 }}>{error}</div>}
      <AgentDefinitionForm value={value} onChange={setValue} errors={errors} capabilities={capabilities} runtimeCatalog={runtimeCatalog} />
      </div>

      {/* Outside the scroll area: always flush with the pane bottom; the form
          scrolls underneath it instead of showing text below the buttons. */}
      <footer aria-label="Agent editor actions" style={{ flexShrink: 0, padding: '12px 56px', borderTop: '1px solid var(--term-line)', background: 'var(--term-page-bg, var(--term-bg))', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" disabled={blocked || draftSaveBlocked(errors)} onClick={() => { void invoke('draft', () => onSaveDraft(value)); }} style={primaryButtonStyle}>Save Draft</button>
        {status === AgentDefinitionStatus.Enabled ? (
          <button type="button" disabled={blocked || !identity || !onDisable} onClick={() => identity && onDisable && void invoke('disable', () => onDisable(identity))} style={outlineButtonStyle}>Disable</button>
        ) : (
          <button type="button" disabled={blocked || Object.keys(errors).length > 0} onClick={() => { void invoke('enable', () => onEnable(value)); }} title={Object.keys(errors).length > 0 ? 'Resolve validation errors before enabling.' : undefined} style={outlineButtonStyle}>Enable</button>
        )}
        {identity && <button type="button" disabled={blocked || !onDuplicate} onClick={() => onDuplicate && void invoke('duplicate', () => onDuplicate(identity))} style={outlineButtonStyle}>Duplicate</button>}
        {identity && <button type="button" disabled={blocked || !onDelete} onClick={() => onDelete && void invoke('delete', () => onDelete(identity))} style={{ ...outlineButtonStyle, color: 'var(--danger, var(--term-error))' }}>Delete</button>}
        <span aria-live="polite" style={{ marginLeft: 'auto', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 11 }}>
          {submitting ? `${submitting}…` : Object.keys(errors).length > 0 ? `${Object.keys(errors).length} validation issue${Object.keys(errors).length === 1 ? '' : 's'}` : 'ready to enable'}
        </span>
      </footer>
    </div>
  );
}

function ScopeBadge({ scope }: { scope: 'global' | 'workspace' }) {
  return <span style={{ border: '1px solid var(--term-line)', padding: '2px 6px', color: 'var(--term-fg)', fontFamily: 'var(--mono-font)', fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase' }}>{scope}</span>;
}

const primaryButtonStyle: React.CSSProperties = { ...outlineButtonStyle, background: 'var(--term-fg)', color: 'var(--term-bg)', borderColor: 'var(--term-fg)', fontWeight: 600 };
