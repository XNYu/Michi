import { API_BASE_URL } from '../../../../config/env';
import { CrewMemorySettings } from '../../CrewMemoryControl';
import { CrewAppSetupNotice } from '../../CrewIntegrationStatus';
import { usePermissionPreferences } from '../../../../hooks/usePermissionPreferences';
import { workspaceBackendApiBase } from '../../../../config/backendConnections';
import { toast } from 'sonner';
import { APPROVE_FOR_ME_CHOICE, PERMISSION_CHOICES } from '../../ComposerPermissionControl';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { Button, Switch } from '../../../ui/controls';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import {
  providerModelLocked,
  providerOptionSuffix,
  providerRequiresUserKey,
  shouldPromptForProviderKey,
} from '../../../../lib/providerCapabilities';
import { useAgentModelCatalog } from '../../../../hooks/useAgentModelCatalog';
import { filterVisibleRuntimes } from '../../../../lib/runtimeVisibility';
import { BedrockConfigPanel } from './BedrockConfigPanel';
import { approveForMeRuntimeIds, supportsChatYolo } from '../../../../lib/chatPermissionModes';
import { chatPermissionChoiceParts, type ChatPermissionChoice } from 'michi-shared';
import { SettingsRow, SettingsSection } from './SettingsSection';
import { ModelCombobox } from './ModelCombobox';

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
  const selectId = useId();
  return (
    <SettingsRow label="Provider" labelFor={selectId}
      description="Switching provider also selects its default model."
      control={<select
        id={selectId}
        className="ui-select settings-row__select"
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
      >
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}{providerOptionSuffix(p)}
          </option>
        ))}
      </select>}>
      {error && <p role="alert" className="settings-row__note">{error}</p>}
    </SettingsRow>
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
  const labelId = useId();
  const triggerId = useId();
  const activeProvider = (status.providers ?? []).find((p) => p.id === status.provider);
  const locked = activeProvider ? providerModelLocked(activeProvider) : false;
  const { models, loading, error: loadError, retry } = useAgentModelCatalog({
    enabled: status.capabilities.models === true,
    runtime: status.runtime,
    provider: status.provider,
  });

  const save = async (model: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const result = await saveAgentOptions({ model, expectedRuntime: status.runtime });
      if (!result.ok) setSaveError(result.error);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Unable to save model');
    } finally {
      setSaving(false);
    }
    onChanged();
  };

  return (
    <SettingsRow label="Model" labelId={labelId}
      description={locked ? 'Model is managed by this built-in provider.' : undefined}
      control={<ModelCombobox
        // A new catalog closes the list and drops its filter.
        key={`${status.runtime}:${status.provider ?? ''}`}
        id={triggerId}
        labelId={labelId}
        value={status.model}
        models={models}
        // Pi lists every model its provider offers, often hundreds.
        searchable={status.runtime === 'pi' || models.length > 7}
        disabled={loading || locked}
        busy={saving}
        placeholder={loading ? 'Loading models…' : 'No models available'}
        onSelect={(model) => void save(model)}
      />}>
      {loading && <p role="status" className="settings-row__note">Loading models…</p>}
      {loadError && (
        <p role="alert" className="settings-row__note">
          {loadError}{' '}
          <button type="button" className="settings-row__link" onClick={retry}>Retry</button>
        </p>
      )}
      {saveError && <p role="alert" className="settings-row__note">{saveError}</p>}
    </SettingsRow>
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
  const [replacing, setReplacing] = useState(false);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const hasKey = !!provider.hasKey;
  // A saved key is a status; the field appears only to add or replace one.
  const editing = !hasKey || replacing;
  const canVerifyKey = hasKey || !!keyDraft.trim();

  useEffect(() => {
    if (replacing) inputRef.current?.focus();
  }, [replacing]);

  const resetDraft = () => {
    setKeyDraft('');
    setKeyError(null);
    setVerifyResult(null);
  };

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
        setReplacing(false);
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
    setKeyError(null);
    setVerifyResult(null);
    try {
      const result = await clearProviderKey(provider.id);
      if (!result.ok) setKeyError(result.error);
    } catch (err: any) {
      setKeyError(err?.message ?? 'Unable to clear API key');
    }
    onChanged();
  };

  const keyConsole = provider.keyUrl ? (
    <a className="settings-row__link" href={provider.keyUrl} target="_blank" rel="noopener noreferrer">
      Open {provider.label} key console
    </a>
  ) : null;
  const verifyLabel = keyVerifying ? 'Verifying…' : 'Verify';

  return (
    <SettingsRow label={`${provider.label} API key`} labelFor={editing ? inputId : undefined}
      description={hasKey ? keyConsole : <>Add a key to use {provider.label}.{keyConsole && <> {keyConsole}</>}</>}
      control={<>
        {/* Same box as the buttons beside it: a status, not a control. */}
        <span className="settings-key-status" data-tone={hasKey ? 'ok' : 'warn'}>
          <span className="settings-key-status__dot" aria-hidden="true" />
          {hasKey ? 'Key saved' : 'Key required'}
        </span>
        {hasKey && !replacing && <>
          <Button disabled={keyVerifying} onClick={() => void verifyKey()}>{verifyLabel}</Button>
          <Button onClick={() => { resetDraft(); setReplacing(true); }}>Replace…</Button>
          <Button variant="ghost" onClick={() => void clearKey()}>Clear</Button>
        </>}
        {hasKey && replacing && (
          <Button variant="ghost" disabled={keySaving} onClick={() => { resetDraft(); setReplacing(false); }}>Cancel</Button>
        )}
      </>}>
      {editing && (
        <div className="settings-key-editor">
          <input
            ref={inputRef}
            id={inputId}
            className="ui-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyDraft}
            placeholder={provider.keyLabel || 'API key'}
            onChange={(e) => {
              setKeyDraft(e.target.value);
              setKeyError(null);
              setVerifyResult(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void saveKey();
              }
            }}
          />
          <Button disabled={!keyDraft.trim() || keyVerifying} onClick={() => void verifyKey()}>{verifyLabel}</Button>
          <Button variant="primary" disabled={!keyDraft.trim() || keySaving} onClick={() => void saveKey()}>
            {keySaving ? 'Saving…' : 'Save key'}
          </Button>
        </div>
      )}
      {verifyResult && (
        <p role={verifyResult.ok ? 'status' : 'alert'} className="settings-row__note" data-tone={verifyResult.ok ? 'ok' : undefined}>
          {verifyResult.ok
            ? `Verified ${provider.label}${verifyResult.model ? ` / ${verifyResult.model}` : ''}${verifyResult.latencyMs ? ` in ${verifyResult.latencyMs}ms` : ''}.`
            : verifyResult.error ?? 'Verification failed.'}
        </p>
      )}
      {keyError && <p role="alert" className="settings-row__note">{keyError}</p>}
    </SettingsRow>
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
        onChange={(global) => { if (!saving && !permissions.loading) void save(global); }} aria-label="Use global permissions" />} />
    {permissions.global && <GlobalPermissionModeRow choice={permissions.choice} disabled={saving || permissions.loading}
      runtimeIds={runtimeIds} approveRuntimeIds={approveRuntimeIds}
      onChange={(choice) => { void save(true, choice); }} />}
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

/** The Composer chip's choices, in its order: Approve for me is a kind of Ask. */
const GLOBAL_PERMISSION_CHOICES = [PERMISSION_CHOICES[0], APPROVE_FOR_ME_CHOICE, ...PERMISSION_CHOICES.slice(1)];

/**
 * The mode every chat uses while permissions are global. It offers what the
 * Composer chip offers for these runtimes: YOLO where one of them supports it,
 * Approve for me where one of them has it, and shows a saved choice the way
 * the runtimes run it (YOLO as Trust, Approve for me as Ask).
 */
function GlobalPermissionModeRow({ choice, disabled, runtimeIds, approveRuntimeIds, onChange }: {
  choice: ChatPermissionChoice;
  disabled: boolean;
  runtimeIds: readonly string[];
  approveRuntimeIds: readonly string[];
  onChange: (choice: ChatPermissionChoice) => void;
}) {
  const selectId = useId();
  const supportsYolo = runtimeIds.some(supportsChatYolo);
  const supportsApprove = runtimeIds.some((id) => approveRuntimeIds.includes(id));
  const shown: ChatPermissionChoice = choice === 'yolo' && !supportsYolo ? 'trust'
    : choice === 'approve' && !supportsApprove ? 'ask' : choice;
  const choices = GLOBAL_PERMISSION_CHOICES.filter((option) =>
    (supportsYolo || option.mode !== 'yolo') && (supportsApprove || option.mode !== 'approve'));
  const current = choices.find((option) => option.mode === shown) ?? choices[0];
  const description = current.mode === 'trust' && !supportsYolo ? 'Approve tool requests automatically.'
    : current.mode === 'approve' && runtimeIds.some((id) => !approveRuntimeIds.includes(id)) ? `${current.description} Other runtimes use Ask.`
      : current.description;
  return (
    <SettingsRow label="Permission mode" labelFor={selectId} description={description}
      control={<select
        id={selectId}
        className="ui-select settings-row__select"
        value={current.mode}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as ChatPermissionChoice)}
      >
        {choices.map((option) => <option key={option.mode} value={option.mode}>{option.label}</option>)}
      </select>} />
  );
}
