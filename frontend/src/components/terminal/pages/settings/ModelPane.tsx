import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '../../../../state/chatStore';
import { usePrefs } from '../../../../state/prefs';
import {
  clearProviderKey,
  saveAgentOptions,
  saveProviderKey,
  verifyProviderKey,
  type AgentProviderInfo,
  type AgentReasoning,
  type AgentStatus,
  type VerifyProviderKeyResult,
} from '../../../../services/api';
import { BorderBtn, Row as ClickableRow } from '../../primitives';
import { Switch } from '../../../ui/controls';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import {
  providerModelLocked,
  providerOptionSuffix,
  providerRequiresUserKey,
  shouldPromptForProviderKey,
} from '../../../../lib/providerCapabilities';
import { useAgentModelCatalog } from '../../../../hooks/useAgentModelCatalog';
import { API_BASE_URL } from '../../../../config/env';
import { filterModelCatalog } from './modelCatalogFilter';

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
  const showRuntimePicker = (agentStatus?.availableRuntimes.length ?? 0) > 1;
  const showProviderPicker = (agentStatus?.providers?.length ?? 0) > 0;
  const showProviderModels = !!caps?.models;
  const showReasoning = !!caps?.reasoning;
  const showApiKeys = !!caps?.apiKeys;

  return (
    <div>
      <h1
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 15,
          fontWeight: 700,
          color: 'var(--term-fg)',
          margin: 0,
        }}
      >
        Model
      </h1>
      <div style={{ marginBottom: 20 }} />

      {showRuntimePicker && agentStatus && (
        <RuntimePicker
          status={agentStatus}
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

      {showApiKeys && agentStatus && (() => {
        const active = (agentStatus.providers ?? []).find((p) => p.id === agentStatus.provider);
        return active && providerRequiresUserKey(active) ? (
          <ProviderKeyControls
            key={active.id}
            provider={active}
            status={agentStatus}
            onChanged={refreshAgentStatus}
          />
        ) : null;
      })()}

      <FollowUpsToggle />
      <BypassPermissionsToggle />

      {activeProjectId && (
        <div style={{ marginTop: 28 }}>
          <PermissionGrantsList projectId={activeProjectId} />
        </div>
      )}
    </div>
  );
}

function RuntimePicker({
  status,
  onChanged,
}: {
  status: AgentStatus;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ fontFamily: 'var(--ui-font)', fontSize: 13, color: 'var(--term-fg)', marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>runtime</div>
      <select
        value={status.runtime}
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
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 12,
          padding: '6px 8px',
          border: '1px solid var(--term-line)',
          background: 'var(--term-surface-glass)',
          color: 'var(--term-fg)',
          minWidth: 320,
        }}
      >
        {status.availableRuntimes.map((r) => (
          <option key={r.id} value={r.id} disabled={!r.available}>
            {r.label}{!r.available ? ' (unavailable)' : ''}
          </option>
        ))}
      </select>
      <div style={{ fontSize: 11, color: 'var(--term-muted)', marginTop: 6, maxWidth: 420, lineHeight: 1.5 }}>
        Switching runtime applies to new chats only — existing sessions keep their original runtime.
      </div>
      {error && (
        <div style={{ fontSize: 11, color: 'var(--term-danger)', marginTop: 6 }}>{error}</div>
      )}
    </div>
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
    <div style={{ fontFamily: 'var(--ui-font)', fontSize: 13, color: 'var(--term-fg)', marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>provider</div>
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
          fontSize: 12,
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
        <div style={{ fontSize: 11, color: 'var(--term-danger)', marginTop: 6 }}>{error}</div>
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
    <div style={{ fontFamily: 'var(--ui-font)', fontSize: 13, color: 'var(--term-fg)', marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>model</div>
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
            fontSize: 12,
            padding: '6px 8px',
            marginBottom: 6,
            border: '1px solid var(--term-line)',
            background: 'var(--term-surface-glass)',
            color: 'var(--term-fg)',
            outlineColor: 'var(--term-accent)',
          }}
        />
      )}
      <select
        value={status.model ?? ''}
        disabled={saving || loading || locked}
        onChange={async (e) => {
          setSaving(true);
          setSaveError(null);
          const result = await saveAgentOptions({ model: e.target.value });
          setSaving(false);
          if (!result.ok) setSaveError(result.error);
          onChanged();
        }}
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 12,
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
            fontSize: 10.5,
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
        <div style={{ fontSize: 11, color: 'var(--term-muted)', marginTop: 6 }}>Loading models…</div>
      )}
      {loadError && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--term-danger)' }}>{loadError}</span>
          <BorderBtn onClick={retry} style={{ padding: '2px 7px', fontSize: 10.5 }}>Retry</BorderBtn>
        </div>
      )}
      {saveError && (
        <div style={{ fontSize: 11, color: 'var(--term-danger)', marginTop: 6 }}>{saveError}</div>
      )}
      {locked && (
        <div style={{ fontSize: 11, color: 'var(--term-muted)', marginTop: 6, maxWidth: 420, lineHeight: 1.5 }}>
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
  return (
    <div style={{ fontFamily: 'var(--ui-font)', fontSize: 13, color: 'var(--term-fg)', marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>reasoning effort</div>
      <select
        value={status.reasoning ?? 'xhigh'}
        disabled={saving}
        onChange={async (e) => {
          setSaving(true);
          setError(null);
          const result = await saveAgentOptions({ reasoning: e.target.value as AgentReasoning });
          setSaving(false);
          if (!result.ok) setError(result.error);
          onChanged();
        }}
        style={{
          fontFamily: 'var(--ui-font)',
          fontSize: 12,
          padding: '6px 8px',
          border: '1px solid var(--term-line)',
          background: 'var(--term-surface-glass)',
          color: 'var(--term-fg)',
          minWidth: 320,
        }}
      >
        {(status.capabilities.supportedReasoningLevels ?? []).map((id) => (
          <option key={id} value={id}>{id}</option>
        ))}
      </select>
      <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginTop: 6, maxWidth: 420, lineHeight: 1.5 }}>
        Some providers ignore reasoning effort, but models that support it will receive this preference.
      </div>
      {error && (
        <div style={{ fontSize: 11, color: 'var(--term-danger)', marginTop: 6 }}>{error}</div>
      )}
    </div>
  );
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
        fontSize: 13,
        color: 'var(--term-fg)',
        marginTop: 18,
        paddingTop: 14,
        borderTop: '1px solid var(--term-line)',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>
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
            fontSize: 12,
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
            fontSize: 12,
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
            fontSize: 12,
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
            fontSize: 12,
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
            fontSize: 11,
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
            fontSize: 11,
            color: 'var(--term-accent)',
            marginTop: 8,
          }}
        >
          Open {provider.label} key console
        </a>
      )}
      {keyError && <div style={{ fontSize: 11, color: 'var(--term-danger)', marginTop: 6 }}>{keyError}</div>}
    </div>
  );
}

function FollowUpsToggle() {
  const { prefs, setPref } = usePrefs();
  const enabled = prefs.enableFollowUps;
  return (
    <div
      style={{
        paddingTop: 18,
        paddingBottom: 4,
        borderTop: '1px solid var(--term-line)',
        marginTop: 18,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: 'var(--term-muted)',
          letterSpacing: '.14em',
          marginBottom: 10,
          fontFamily: 'var(--ui-font)',
        }}
      >
        ▸ FOLLOW-UPS
      </div>
      <ClickableRow
        onClick={() => setPref('enableFollowUps', !enabled)}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '6px 6px',
          margin: '0 -6px',
        }}
      >
        <span style={{ marginTop: 1 }}>
          <Switch on={enabled} onChange={(v) => setPref('enableFollowUps', v)} aria-label="Generate follow-up questions" />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span
            style={{
              fontSize: 12.5,
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              fontWeight: 600,
            }}
          >
            Generate follow-up questions
          </span>
        </div>
      </ClickableRow>
    </div>
  );
}

function BypassPermissionsToggle() {
  const { prefs, setPref } = usePrefs();
  const enabled = prefs.bypassPermissions;
  return (
    <div
      style={{
        paddingTop: 18,
        paddingBottom: 4,
        borderTop: '1px solid var(--term-line)',
        marginTop: 18,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: 'var(--term-muted)',
          letterSpacing: '.14em',
          marginBottom: 10,
          fontFamily: 'var(--ui-font)',
        }}
      >
        ▸ PERMISSIONS
      </div>
      <ClickableRow
        onClick={() => setPref('bypassPermissions', !enabled)}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '6px 6px',
          margin: '0 -6px',
        }}
      >
        <span style={{ marginTop: 1 }}>
          <Switch on={enabled} onChange={(v) => setPref('bypassPermissions', v)} aria-label="Bypass all permissions" />
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span
            style={{
              fontSize: 12.5,
              color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)',
              fontWeight: 600,
            }}
          >
            Bypass all permissions
          </span>
          <span
            style={{
              fontSize: 11,
              color: 'var(--term-muted)',
              fontFamily: 'var(--ui-font)',
            }}
          >
            Auto-approve all tool calls without showing the permission banner.
          </span>
        </div>
      </ClickableRow>
    </div>
  );
}

interface PermissionGrant {
  workspace_id: string;
  tool_name: string;
  granted_at: number;
}

function PermissionGrantsList({ projectId }: { projectId: string }) {
  const [grants, setGrants] = useState<PermissionGrant[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/workspaces/${projectId}/permission-grants`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { grants: PermissionGrant[] };
      setGrants(data.grants ?? []);
    } catch {
      setGrants([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(toolName: string) {
    setBusy(toolName);
    try {
      await fetch(
        `${API_BASE_URL}/workspaces/${projectId}/permission-grants/${encodeURIComponent(toolName)}`,
        { method: 'DELETE' },
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ paddingTop: 18, borderTop: '1px solid var(--term-line)' }}>
      <div
        style={{
          fontSize: 10,
          color: 'var(--term-muted)',
          letterSpacing: '.14em',
          marginBottom: 10,
          fontFamily: 'var(--ui-font)',
        }}
      >
        ▸ ALWAYS-ALLOW GRANTS
      </div>
      <div
        style={{
          fontSize: 11,
          color: 'var(--term-muted)',
          fontFamily: 'var(--ui-font)',
          lineHeight: 1.5,
          maxWidth: 460,
          marginBottom: 10,
        }}
      >
        Tools you've allowed to run without prompting in this workspace.
        Revoke any to be asked again on the next call.
      </div>
      {grants === null ? (
        <div style={{ fontFamily: 'var(--ui-font)', fontSize: 12, color: 'var(--term-muted)' }}>
          loading…
        </div>
      ) : grants.length === 0 ? (
        <div style={{ fontFamily: 'var(--ui-font)', fontSize: 12, color: 'var(--term-muted)' }}>
          No always-allow grants yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
          {grants.map((g, i) => (
            <div
              key={g.tool_name}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                borderBottom: i < grants.length - 1 ? '1px solid var(--term-line)' : 'none',
                background: 'var(--term-surface-glass)',
                fontFamily: 'var(--ui-font)',
                fontSize: 12,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ color: 'var(--term-fg)', fontWeight: 600 }}>{g.tool_name}</span>
                <span style={{ color: 'var(--term-muted)', fontSize: 10.5 }}>
                  granted {new Date(g.granted_at).toLocaleString()}
                </span>
              </div>
              <BorderBtn
                onClick={() => !busy && void revoke(g.tool_name)}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  border: '1px solid var(--term-line)',
                  color: 'var(--term-danger)',
                  background: 'transparent',
                  fontFamily: 'var(--ui-font)',
                  opacity: busy === g.tool_name ? 0.5 : 1,
                }}
              >
                revoke
              </BorderBtn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
