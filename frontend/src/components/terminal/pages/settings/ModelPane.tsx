import { API_BASE_URL } from '../../../../config/env';
import { CrewMemorySettings } from '../../CrewMemoryControl';
import { CrewAppSetupNotice } from '../../CrewIntegrationStatus';
import { usePermissionPreferences } from '../../../../hooks/usePermissionPreferences';
import { workspaceBackendApiBase } from '../../../../config/backendConnections';
import { toast } from 'sonner';
import { ComposerPermissionControl } from '../../ComposerPermissionControl';
import React, { useEffect, useId, useMemo, useState } from 'react';
import { useChatStore } from '../../../../state/chatStore';
import { usePrefs } from '../../../../state/prefs';
import {
  clearProviderKey,
  saveAgentOptions,
  saveProviderKey,
  saveWebSearchKey,
  clearWebSearchKey,
  verifyProviderKey,
  type AgentProviderInfo,
  type AgentReasoning,
  type AgentStatus,
  type VerifyProviderKeyResult,
  type WebSearchProviderInfo,
} from '../../../../services/api';
import { BorderBtn } from '../../primitives';
import { Switch } from '../../../ui/controls';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import {
  providerModelLocked,
  providerOptionSuffix,
  providerRequiresUserKey,
  shouldPromptForProviderKey,
} from '../../../../lib/providerCapabilities';
import { useAgentModelCatalog } from '../../../../hooks/useAgentModelCatalog';
import { filterModelCatalog } from './modelCatalogFilter';
import { filterVisibleRuntimes } from '../../../../lib/runtimeVisibility';
import { BedrockConfigPanel } from './BedrockConfigPanel';
import { approveForMeRuntimeIds, supportsChatYolo } from '../../../../lib/chatPermissionModes';
import { chatPermissionChoiceParts } from 'michi-shared';
import { SettingsRow, SettingsSection } from './SettingsSection';

export function ModelPane({
  activeProjectId,
}: {
  activeProjectId: string | null;
}) {
  const { agentStatus, refreshAgentStatus } = useChatStore();

  // Refetch agent status when this pane opens — `agentStatus` is fetched once
  // at chatStore mount, so without this the picker would show stale capabilities
  // after backend-side changes (e.g. runtime added, reasoning levels changed).
  useEffect(() => {
    refreshAgentStatus();
  }, [refreshAgentStatus]);

  const caps = agentStatus?.capabilities;
  const visibleRuntimes = useMemo(
    () => filterVisibleRuntimes(agentStatus?.availableRuntimes ?? []),
    [agentStatus?.availableRuntimes],
  );
  const showRuntimePicker = visibleRuntimes.length > 1
    || (visibleRuntimes.length === 1 && visibleRuntimes[0].id !== agentStatus?.runtime);
  const showProviderPicker = (agentStatus?.providers?.length ?? 0) > 0;
  const showProviderModels = !!caps?.models;
  const showReasoning = !!caps?.reasoning;
  const showApiKeys = !!caps?.apiKeys;
  const showKiroSidecarTitles = agentStatus?.runtime === 'kiro'
    && agentStatus.availableRuntimes.some((runtime) => runtime.id === 'kiro' && runtime.available);

  return (
    <div className="model-pane">
      <SettingsSection title="Model">
      {showRuntimePicker && agentStatus && (
        <RuntimePicker
          status={agentStatus}
          runtimes={visibleRuntimes}
          onChanged={refreshAgentStatus}
        />
      )}

      {showProviderPicker && agentStatus && (
        <ProviderPicker
          status={agentStatus}
          onChanged={refreshAgentStatus}
        />
      )}

      {showProviderModels && agentStatus && (
        <ProviderModelPicker
          status={agentStatus}
          onChanged={refreshAgentStatus}
        />
      )}

      {showReasoning && agentStatus && (
        <ReasoningPicker
          status={agentStatus}
          onChanged={refreshAgentStatus}
        />
      )}

      {agentStatus?.capabilities.nativeResume && agentStatus.nativeResumeByRuntime && (
        <NativeSessionToggle key={`${agentStatus.runtime}-resume`} status={agentStatus} preference="nativeResumeByRuntime" label="Native Resume" onChanged={refreshAgentStatus} />
      )}

      {agentStatus?.capabilityDescriptor?.sessionFork.availability === 'native' && agentStatus.nativeForkByRuntime && (
        <NativeSessionToggle key={`${agentStatus.runtime}-fork`} status={agentStatus} preference="nativeForkByRuntime" label="Native Fork" onChanged={refreshAgentStatus} />
      )}

      {agentStatus && (agentStatus.workflowRuntimes ?? []).filter((runtimeId) => runtimeId === agentStatus.runtime).map((runtimeId) => (
        <WorkflowsToggle key={`${runtimeId}-workflows`} status={agentStatus} runtimeId={runtimeId} onChanged={refreshAgentStatus} />
      ))}

      {showApiKeys && agentStatus && (() => {
        const active = (agentStatus.providers ?? []).find((p) => p.id === agentStatus.provider);
        if (!active) return null;
        if (active.id === 'amazon-bedrock') {
          return <BedrockConfigPanel key={active.id} provider={active} onChanged={refreshAgentStatus} />;
        }
        return active && providerRequiresUserKey(active) ? (
          <ProviderKeyControls
            key={active.id}
            provider={active}
            status={agentStatus}
            onChanged={refreshAgentStatus}
          />
        ) : null;
      })()}
      </SettingsSection>

      {agentStatus && <WebSearchControls status={agentStatus} onChanged={refreshAgentStatus} />}

      {showKiroSidecarTitles && <KiroSidecarTitleToggle />}
      {agentStatus?.runtime === 'crew' && <><CrewAppSetupNotice apiBase={activeProjectId ? workspaceBackendApiBase(activeProjectId) : API_BASE_URL} />
        <CrewMemorySettings apiBase={activeProjectId ? workspaceBackendApiBase(activeProjectId) : API_BASE_URL} /></>}
      <FollowUpsToggle />
      <PermissionSettings apiBase={activeProjectId ? workspaceBackendApiBase(activeProjectId) : undefined}
        runtimeIds={[...(agentStatus ? [agentStatus.runtime] : []), ...visibleRuntimes.map((runtime) => runtime.id)]}
        approveRuntimeIds={approveForMeRuntimeIds(agentStatus)} />


    </div>
  );
}

function NativeSessionToggle({ status, preference, label, onChanged }: {
  status: AgentStatus;
  preference: 'nativeResumeByRuntime' | 'nativeForkByRuntime';
  label: string;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(status[preference]?.[status.runtime] !== false);
  useEffect(() => { setEnabled(status[preference]?.[status.runtime] !== false); }, [status, preference]);

  const save = async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveAgentOptions(preference === 'nativeResumeByRuntime'
        ? { nativeResumeByRuntime: { [status.runtime]: value } }
        : { nativeForkByRuntime: { [status.runtime]: value } });
      if (!result.ok) { setError(result.error); return; }
      setEnabled(value);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Unable to save ${label}`);
    } finally { setSaving(false); }
  };

  return (
    <SettingsRow label={label} description={status.label}
      control={<Switch on={enabled} disabled={saving} onChange={(value) => void save(value)} aria-label={`${label} for ${status.label}`} />}>
      {error && <p role="alert" className="settings-row__note">{error}</p>}
    </SettingsRow>
  );
}

/**
 * Kiro CLI workflows are opt-in: a workflow runs long, multi-agent work in
 * the background. Applies to sessions opened after the change.
 */
function WorkflowsToggle({ status, runtimeId, onChanged }: { status: AgentStatus; runtimeId: string; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(status.workflowsByRuntime?.[runtimeId] === true);
  useEffect(() => { setEnabled(status.workflowsByRuntime?.[runtimeId] === true); }, [status, runtimeId]);
  const label = status.availableRuntimes.find((runtime) => runtime.id === runtimeId)?.label ?? runtimeId;

  const save = async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveAgentOptions({ workflowsByRuntime: { [runtimeId]: value } });
      if (!result.ok) { setError(result.error); return; }
      setEnabled(value);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save Workflows');
    } finally { setSaving(false); }
  };

  return (
    <SettingsRow label={`Workflows (${label})`}
      description="Lets the agent run multi-step workflows in the background. Progress shows under the message that launched it. Applies to new chats."
      control={<Switch on={enabled} disabled={saving} onChange={(value) => void save(value)} aria-label={`Workflows for ${label}`} />}>
      {error && <p role="alert" className="settings-row__note">{error}</p>}
    </SettingsRow>
  );
}

function RuntimePicker({
  status,
  runtimes,
  onChanged,
}: {
  status: AgentStatus;
  runtimes: AgentStatus['availableRuntimes'];
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const selectedRuntime = runtimes.some((runtime) => runtime.id === status.runtime)
    ? status.runtime
    : '';
  return (
    <SettingsRow label="Runtime" labelFor={selectId}
      description="Applies to new chats. Existing chats keep the runtime they started with."
      control={<select
        id={selectId}
        className="ui-select settings-row__select"
        aria-label="Runtime"
        value={selectedRuntime}
        disabled={saving}
        onChange={async (e) => {
          const next = e.target.value;
          setSaving(true);
          setError(null);
          const result = await saveAgentOptions({ runtime: next });
          setSaving(false);
          if (!result.ok) setError(result.error);
          onChanged();
        }}
      >
        {selectedRuntime === '' && (
          <option value="" disabled>Select an available runtime</option>
        )}
        {runtimes.map((r) => (
          <option key={r.id} value={r.id} disabled={!r.available}>
            {r.label}{!r.available ? ' (unavailable)' : ''}
          </option>
        ))}
      </select>}>
      {error && <p role="alert" className="settings-row__note">{error}</p>}
    </SettingsRow>
  );
}

function ProviderPicker({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}) {
  const providers = status.providers ?? [];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-lg)', color: 'var(--term-fg)', marginBottom: 18 }}>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginBottom: 4 }}>provider</div>
      <select
        value={status.provider ?? ''}
        disabled={saving}
        onChange={async (e) => {
          const nextId = e.target.value;
          const provider = providers.find((p) => p.id === nextId);
          if (!provider) return;
          setSaving(true);
          setError(null);
          // Switching provider also resets the model to that provider's default.
          const result = await saveAgentOptions({
            provider: provider.id,
            model: provider.defaultModel,
            expectedRuntime: status.runtime,
          });
          setSaving(false);
          if (!result.ok) setError(result.error);
          // Missing-key providers reopen ApiKeyGate so the user gets the
          // setup window. Providers that already have a key refresh silently
          // so the modal does not cover Settings for a no-op switch.
          if (typeof window !== 'undefined' && !shouldPromptForProviderKey(provider)) {
            window.dispatchEvent(
              new CustomEvent('michi:reload-agent-status', { detail: { silent: true } }),
            );
          } else {
            onChanged();
          }
        }}
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-md)',
          padding: '6px 8px',
          border: '1px solid var(--term-line)',
          background: 'var(--term-surface-glass)',
          color: 'var(--term-fg)',
          minWidth: 320,
        }}
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}{providerOptionSuffix(p)}
          </option>
        ))}
      </select>
      {error && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)', marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
}

function ProviderModelPicker({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const activeProvider = (status.providers ?? []).find((p) => p.id === status.provider);
  const locked = activeProvider ? providerModelLocked(activeProvider) : false;
  const { models, loading, error: loadError, retry } = useAgentModelCatalog({
    enabled: status.capabilities.models === true,
    runtime: status.runtime,
    provider: status.provider,
  });
  const showFilter = status.runtime === 'pi' && !locked && models.length > 0;
  const filteredModels = useMemo(
    () => filterModelCatalog(models, filterQuery),
    [filterQuery, models],
  );
  const selectedModel = status.model
    ? models.find((model) => model.id === status.model)
    : undefined;
  const selectedIsFilteredOut = !!selectedModel
    && !filteredModels.some((model) => model.id === selectedModel.id);
  const visibleModels = selectedIsFilteredOut
    ? [selectedModel, ...filteredModels]
    : filteredModels;
  const activeModelMissing = !!status.model
    && !models.some((model) => model.id === status.model);

  useEffect(() => {
    setFilterQuery('');
  }, [status.provider, status.runtime]);

  return (
    <div style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-lg)', color: 'var(--term-fg)', marginBottom: 18 }}>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginBottom: 4 }}>model</div>
      {showFilter && (
        <input
          type="search"
          aria-label="Filter models"
          autoComplete="off"
          spellCheck={false}
          value={filterQuery}
          onChange={(event) => setFilterQuery(event.target.value)}
          placeholder="Filter by name or ID…"
          style={{
            display: 'block',
            width: 320,
            boxSizing: 'border-box',
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            padding: '6px 8px',
            marginBottom: 6,
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-fg)',
            outline: 'none',
          }}
        />
      )}
      <select
        value={status.model ?? ''}
        disabled={saving || loading || locked}
        onChange={async (e) => {
          setSaving(true);
          setSaveError(null);
          const result = await saveAgentOptions({ model: e.target.value, expectedRuntime: status.runtime });
          setSaving(false);
          if (!result.ok) setSaveError(result.error);
          onChanged();
        }}
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 'var(--fs-md)',
          padding: '6px 8px',
          border: '1px solid var(--term-line)',
          background: 'var(--term-surface-glass)',
          color: 'var(--term-fg)',
          minWidth: 320,
        }}
      >
        {/* Render the active model as its own option even if not in the list (rare race). */}
        {(models.length === 0 || activeModelMissing) && status.model && (
          <option value={status.model}>{status.model}</option>
        )}
        {models.length === 0 && !status.model && (
          <option value="">{loading ? 'Loading models…' : 'No models available'}</option>
        )}
        {visibleModels.map((m) => (
          <option key={m.id} value={m.id}>{m.label || m.id}</option>
        ))}
      </select>
      {showFilter && filterQuery.trim() && (
        <div
          role="status"
          style={{
            fontSize: 'var(--fs-sm)',
            color: filteredModels.length === 0 ? 'var(--term-danger)' : 'var(--term-muted)',
            marginTop: 6,
          }}
        >
          {filteredModels.length === 0
            ? `No models match “${filterQuery.trim()}”.`
            : `${filteredModels.length} of ${models.length} models`}
        </div>
      )}
      {loading && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginTop: 6 }}>Loading models…</div>
      )}
      {loadError && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)' }}>{loadError}</span>
          <BorderBtn onClick={retry} style={{ padding: '2px 7px', fontSize: 'var(--fs-sm)' }}>Retry</BorderBtn>
        </div>
      )}
      {saveError && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)', marginTop: 6 }}>{saveError}</div>
      )}
      {locked && (
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginTop: 6, maxWidth: 420, lineHeight: 1.5 }}>
          Model is managed by this built-in provider.
        </div>
      )}
    </div>
  );
}

function ReasoningPicker({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  return (
    <SettingsRow label="Reasoning effort" labelFor={selectId}
      description="Models that support it receive this preference; some providers ignore it."
      control={<select
        id={selectId}
        className="ui-select settings-row__select"
        value={status.reasoning ?? 'xhigh'}
        disabled={saving}
        onChange={async (e) => {
          setSaving(true);
          setError(null);
          const result = await saveAgentOptions({ reasoning: e.target.value as AgentReasoning, expectedRuntime: status.runtime });
          setSaving(false);
          if (!result.ok) setError(result.error);
          onChanged();
        }}
      >
        {(status.capabilities.supportedReasoningLevels ?? []).map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
      </select>}>
      {error && <p role="alert" className="settings-row__note">{error}</p>}
    </SettingsRow>
  );
}

function WebSearchControls({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}) {
  const providers = status.webSearchProviders ?? [];
  const [savingProvider, setSavingProvider] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);

  // Old deployments do not return this field. Hiding the entire group makes
  // the Settings page backwards-compatible with those remote backends.
  if (providers.length === 0) return null;

  const selectedId = status.webSearchProvider ?? '';
  const selected = providers.find((provider) => provider.id === selectedId);

  const updateProvider = async (value: string) => {
    if (savingProvider) return;
    setSavingProvider(true);
    setProviderError(null);
    try {
      const result = await saveAgentOptions({ webSearchProvider: value || null });
      if (!result.ok) setProviderError(result.error);
      onChanged();
    } catch (error: any) {
      setProviderError(error?.message ?? 'Unable to update web search');
    } finally {
      setSavingProvider(false);
    }
  };

  return (
    <SettingsSection title="Web search">
      <SettingsRow label="Search provider"
        description="Searches run from the backend. A new chat will expose the selected provider as a source-aware web-search tool."
        control={<select
          className="ui-select settings-row__select"
          aria-label="Web search provider"
          value={selectedId}
          disabled={savingProvider}
          onChange={(event) => void updateProvider(event.target.value)}
        >
          <option value="">Disabled</option>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}{provider.hasKey ? '' : ' (key required)'}
            </option>
          ))}
        </select>}>
        {providerError && <p role="alert" className="settings-row__note">{providerError}</p>}
        {selected && <WebSearchKeyControls key={selected.id} provider={selected} onChanged={onChanged} />}
      </SettingsRow>
    </SettingsSection>
  );
}

function WebSearchKeyControls({
  provider,
  onChanged,
}: {
  provider: WebSearchProviderInfo;
  onChanged: () => void;
}) {
  const [keyDraft, setKeyDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const hasKey = provider.hasKey;

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await saveWebSearchKey(provider.id, key);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setKeyDraft('');
      onChanged();
    } catch (saveError: any) {
      setError(saveError?.message ?? 'Unable to save API key');
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    if (!hasKey) return;
    if (!(await confirmDialog({
      title: 'Clear search API key',
      message: `Clear the saved ${provider.label} API key?`,
      confirmLabel: 'Clear',
    }))) return;
    const result = await clearWebSearchKey(provider.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onChanged();
  };

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginBottom: 4 }}>
        {provider.label} {hasKey ? '(saved)' : '(missing)'}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          aria-label={`${provider.label} API key`}
          type="password"
          value={keyDraft}
          onChange={(event) => {
            setKeyDraft(event.target.value);
            setError(null);
          }}
          placeholder={provider.keyLabel}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            padding: '6px 8px',
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-fg)',
            minWidth: 320,
            outline: 'none',
          }}
        />
        <button
          onClick={() => void saveKey()}
          disabled={!keyDraft.trim() || saving}
          style={keyButtonStyle(!keyDraft.trim() || saving)}
        >
          {saving ? 'Saving...' : 'Save key'}
        </button>
        <button
          onClick={() => void clearKey()}
          disabled={!hasKey}
          style={{ ...keyButtonStyle(!hasKey), color: 'var(--term-mid)' }}
        >
          Clear
        </button>
      </div>
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginTop: 7, maxWidth: 500, lineHeight: 1.5 }}>
        {provider.description}
      </div>
      <a
        href={provider.keyUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ display: 'inline-block', fontSize: 'var(--fs-sm)', color: 'var(--term-accent)', marginTop: 7 }}
      >
        Open {provider.label} key console
      </a>
      {error && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)', marginTop: 6 }}>{error}</div>}
    </div>
  );
}

function keyButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: 'var(--ui-font)',
    fontSize: 'var(--fs-md)',
    padding: '6px 12px',
    border: '1px solid var(--term-line)',
    background: 'var(--term-surface-glass)',
    color: 'var(--term-fg)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
}

function ProviderKeyControls({
  provider,
  status,
  onChanged,
}: {
  provider: AgentProviderInfo;
  status: AgentStatus;
  onChanged: () => void;
}) {
  const [keyDraft, setKeyDraft] = useState('');
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const [keyVerifying, setKeyVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyProviderKeyResult | null>(null);

  const hasKey = !!provider.hasKey;
  const canVerifyKey = hasKey || !!keyDraft.trim();

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key || keySaving) return;
    setKeySaving(true);
    setKeyError(null);
    try {
      const result = await saveProviderKey(provider.id, key);
      if (!result.ok) {
        setKeyError(result.error);
      } else {
        setKeyDraft('');
        setVerifyResult(null);
        onChanged();
      }
    } catch (err: any) {
      setKeyError(err?.message ?? 'Unable to save API key');
    } finally {
      setKeySaving(false);
    }
  };

  const verifyKey = async () => {
    if (!canVerifyKey || keyVerifying) return;
    setKeyVerifying(true);
    setKeyError(null);
    setVerifyResult(null);
    try {
      // When verifying the active provider, use whatever model is currently
      // selected so we don't surprise the user. Otherwise verify against the
      // provider's default.
      const isActive = provider.id === status.provider;
      const result = await verifyProviderKey(provider.id, {
        key: keyDraft.trim() || undefined,
        model: isActive ? status.model : provider.defaultModel,
      });
      setVerifyResult(result);
    } catch (err: any) {
      setVerifyResult({ ok: false, error: err?.message ?? 'Unable to verify API key' });
    } finally {
      setKeyVerifying(false);
    }
  };

  const clearKey = async () => {
    if (!hasKey) return;
    if (!(await confirmDialog({
      title: 'Clear API key',
      message: `Clear the saved ${provider.label} API key?`,
      confirmLabel: 'Clear',
    }))) return;
    await clearProviderKey(provider.id);
    setVerifyResult(null);
    onChanged();
  };

  return (
    <div
      style={{
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-lg)',
        color: 'var(--term-fg)',
        marginTop: 18,
        paddingTop: 14,
        borderTop: '1px solid var(--term-line)',
      }}
    >
      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginBottom: 4 }}>
        {provider.label} {hasKey ? '(saved)' : '(missing)'}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="password"
          value={keyDraft}
          onChange={(e) => {
            setKeyDraft(e.target.value);
            setKeyError(null);
            setVerifyResult(null);
          }}
          placeholder="API key"
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            padding: '6px 8px',
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-fg)',
            minWidth: 320,
            outline: 'none',
          }}
        />
        <button
          onClick={() => void saveKey()}
          disabled={!keyDraft.trim() || keySaving}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            padding: '6px 12px',
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-fg)',
            cursor: !keyDraft.trim() || keySaving ? 'default' : 'pointer',
            opacity: !keyDraft.trim() || keySaving ? 0.55 : 1,
          }}
        >
          {keySaving ? 'Saving...' : 'Save key'}
        </button>
        <button
          onClick={() => void verifyKey()}
          disabled={!canVerifyKey || keyVerifying}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            padding: '6px 12px',
            border: '1px solid var(--term-line)',
            background: verifyResult?.ok ? 'var(--term-alt)' : 'var(--term-surface)',
            color: verifyResult?.ok ? 'var(--term-accent)' : 'var(--term-fg)',
            cursor: !canVerifyKey || keyVerifying ? 'default' : 'pointer',
            opacity: !canVerifyKey || keyVerifying ? 0.55 : 1,
          }}
        >
          {keyVerifying ? 'Verifying...' : 'Verify'}
        </button>
        <button
          onClick={() => void clearKey()}
          disabled={!hasKey}
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 'var(--fs-md)',
            padding: '6px 12px',
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-mid)',
            cursor: hasKey ? 'pointer' : 'default',
            opacity: hasKey ? 1 : 0.55,
          }}
        >
          Clear
        </button>
      </div>
      {verifyResult && (
        <div
          style={{
            fontSize: 'var(--fs-sm)',
            color: verifyResult.ok ? 'var(--term-accent)' : 'var(--term-danger)',
            marginTop: 6,
          }}
        >
          {verifyResult.ok
            ? `Verified ${provider.label}${verifyResult.model ? ` / ${verifyResult.model}` : ''}${verifyResult.latencyMs ? ` in ${verifyResult.latencyMs}ms` : ''}.`
            : verifyResult.error ?? 'Verification failed.'}
        </div>
      )}
      {provider.keyUrl && (
        <a
          href={provider.keyUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-block',
            fontSize: 'var(--fs-sm)',
            color: 'var(--term-accent)',
            marginTop: 8,
          }}
        >
          Open {provider.label} key console
        </a>
      )}
      {keyError && <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)', marginTop: 6 }}>{keyError}</div>}
    </div>
  );
}

function KiroSidecarTitleToggle() {
  const { prefs, setPref } = usePrefs();
  const enabled = prefs.enableKiroSidecarTitles;
  return (
    <SettingsSection title="Titles">
      <SettingsRow label="Generate Kiro titles in background"
        description="Runs a separate Kiro request for untitled chats. Disabled by default because it may arrive after the main response."
        control={<Switch on={enabled} onChange={(value) => setPref('enableKiroSidecarTitles', value)} aria-label="Generate Kiro titles in background" />} />
    </SettingsSection>
  );
}

function FollowUpsToggle() {
  const { prefs, setPref } = usePrefs();
  const enabled = prefs.enableFollowUps;
  return (
    <SettingsSection title="Follow-ups">
      <SettingsRow label="Generate follow-up questions"
        control={<Switch on={enabled} onChange={(v) => setPref('enableFollowUps', v)} aria-label="Generate follow-up questions" />} />
    </SettingsSection>
  );
}

/**
 * Settings apply to Claude chats in every workspace, including ones this
 * window does not follow, so the restart note is static rather than tied to
 * workflows seen running here.
 */
const CLAUDE_YOLO_RESTART_NOTE = 'Moving a Claude chat into or out of YOLO restarts it on its next message, which stops any workflow it is running.';

function PermissionSettings({ apiBase, runtimeIds, approveRuntimeIds }: { apiBase?: string; runtimeIds: readonly string[]; approveRuntimeIds: readonly string[] }) {
  const claudeAvailable = runtimeIds.includes('claude');
  const permissions = usePermissionPreferences(apiBase);
  const supportsYolo = runtimeIds.some(supportsChatYolo);
  const [saving, setSaving] = useState(false);
  const save = async (global: boolean, choice = permissions.choice) => {
    setSaving(true);
    const { mode, approveForMe } = chatPermissionChoiceParts(choice);
    try { await permissions.save({ global, mode, ...(approveForMe ? { approveForMe } : {}) }); }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to save permission settings'); }
    finally { setSaving(false); }
  };
  return <SettingsSection title="Permissions">
    <SettingsRow label="Use global permissions"
      description={permissions.global ? 'One permission mode for all chats. Permission controls are hidden in the Composer.' : 'Set permissions separately in each chat’s Composer. New chats start in Ask.'}
      control={<Switch on={permissions.global} disabled={saving || permissions.loading}
        onChange={(global) => { if (!saving && !permissions.loading) void save(global); }} aria-label="Use global permissions" />}>
      {permissions.global && <ComposerPermissionControl scope="global" mode={permissions.choice} disabled={saving || permissions.loading}
        runtimeIds={runtimeIds} approveForMeRuntimeIds={approveRuntimeIds}
        yoloRestartHint={claudeAvailable ? CLAUDE_YOLO_RESTART_NOTE : undefined}
        onChange={(choice) => save(true, choice)} />}
    </SettingsRow>
    {permissions.error && <p role="alert" className="settings-section__status">{permissions.error} <button type="button" className="settings-row__link" onClick={() => { void permissions.retry(); }} disabled={permissions.loading}>Retry</button></p>}
    <p className="settings-section__status model-pane__permissions-note">
      {supportsYolo
        ? 'Changes apply to the next turn. Trust keeps native sandbox limits; YOLO uses full access where supported. Kiro, Crew and Pi use Trust for YOLO. Agent Runs use their own permissions.'
        : 'Changes apply to the next turn. Ask requests approval; Trust approves tools automatically. Agent Runs use their own permissions.'}
      {approveRuntimeIds.length > 0 ? ' Approve for me lets Kiro V3 approve routine work and ask when unsure; other runtimes use Ask.' : null}
      {/* Turning global permissions on or off can also cross YOLO. */}
      {claudeAvailable && supportsYolo ? ` ${CLAUDE_YOLO_RESTART_NOTE}` : null}
    </p>
  </SettingsSection>;
}
