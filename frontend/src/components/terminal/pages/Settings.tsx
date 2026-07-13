import React, { useEffect, useState } from 'react';
import { useChatStore, useStructuralSelector } from '../../../state/chatStore';
import { usePrefs, TerminalPalette, CodeBlockStyle } from '../../../state/prefs';
import type { PageId } from '../../../state/commands';
import { isArchiveGroupId } from '../../../state/trashActions';
import {
  clearProviderKey,
  saveAgentOptions,
  saveProviderKey,
  verifyProviderKey,
  type AgentProviderInfo,
  type AgentReasoning,
  type AgentStatus,
  type VerifyProviderKeyResult,
} from '../../../services/api';
import { Tab, BorderBtn, Row as ClickableRow } from '../primitives';
import { resolveAccent } from '../tokens';
import { authClient } from '../../../services/auth';
import { signOutAndReset } from '../../../services/signOut';
import { kbd } from '../../../lib/platform';
import { API_BASE_URL } from '../../../config/env';
import {
  providerModelLocked,
  providerOptionSuffix,
  providerRequiresUserKey,
} from '../../../lib/providerCapabilities';
import { useAgentModelCatalog } from '../../../hooks/useAgentModelCatalog';

type Section = 'model' | 'appearance' | 'shortcuts' | 'notifications' | 'account';

export default function TerminalSettings({
  onNav,
  onClose,
}: {
  onNav?: (p: PageId) => void;
  onClose?: () => void;
} = {}) {
  const [section, setSection] = useState<Section>('appearance');
  const { activeProject, projects } = useChatStore();
  const { resetTerminal } = usePrefs();

  const trashGroupCount = useStructuralSelector((nodesMap) => {
    const gids = new Set<string>();
    for (const n of Object.values(nodesMap)) {
      if (n.deletionGroupId && !isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId);
    }
    return gids.size;
  });
  const trashCount = trashGroupCount + projects.filter((p) => p.deletedAt).length;
  const archivedCount = useStructuralSelector((nodesMap) => {
    const gids = new Set<string>();
    for (const n of Object.values(nodesMap)) {
      if (isArchiveGroupId(n.deletionGroupId)) gids.add(n.deletionGroupId!);
    }
    return gids.size;
  });

  // The Account tab only renders when the user is signed in. In desktop /
  // Electron mode useSession().data is null and we hide it entirely.
  const session = authClient.useSession();
  const signedIn = !!session.data?.user;

  const sections: Array<[Section, string]> = [
    ['model', 'Model'],
    ['appearance', 'Appearance'],
    ['notifications', 'Notifications'],
    ['shortcuts', 'Shortcuts'],
    ...(signedIn ? ([['account', 'Account']] as Array<[Section, string]>) : []),
  ];

  const openTrashPage = () => {
    onClose?.();
    onNav?.('trash');
  };

  const openArchivedPage = () => {
    onClose?.();
    onNav?.('archived');
  };

  return (
    <div
      className="term-scrollbar"
      style={{
        flex: 1,
        minHeight: 0,
        /* Transparent so the drawer's .term-glass frost shows through; individual
           controls keep their own solid surfaces (macOS-vibrancy panel look). */
        background: 'transparent',
        overflowY: 'auto',
        padding: '14px 16px 20px',
      }}
    >
      {/* horizontal tabs */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid var(--term-line)',
          marginBottom: 14,
          flexWrap: 'nowrap',
          whiteSpace: 'nowrap',
        }}
      >
        {sections.map(([k, l]) => {
          const active = section === k;
          return (
            <Tab
              key={k}
              focused={active}
              onClick={() => setSection(k)}
              style={{
                padding: '6px 7px',
                fontSize: 11,
                fontFamily: 'var(--ui-font)',
                color: active ? 'var(--term-fg)' : 'var(--term-mid)',
                borderBottom: active ? '2px solid var(--term-accent)' : '2px solid transparent',
                marginBottom: -1,
                fontWeight: active ? 600 : 400,
              }}
            >
              {l}
            </Tab>
          );
        })}
        <Tab
          focused={false}
          onClick={openTrashPage}
          style={{
            padding: '6px 7px',
            fontSize: 11,
            fontFamily: 'var(--ui-font)',
            color: 'var(--term-mid)',
            borderBottom: '2px solid transparent',
            marginBottom: -1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Trash
          {trashCount > 0 && (
            <span
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 9.5,
                color: 'var(--term-surface)',
                background: 'var(--term-muted)',
                padding: '0 5px',
                minWidth: 16,
                textAlign: 'center',
                fontWeight: 700,
              }}
            >
              {trashCount}
            </span>
          )}
        </Tab>
        <Tab
          focused={false}
          onClick={openArchivedPage}
          style={{
            padding: '6px 7px',
            fontSize: 11,
            fontFamily: 'var(--ui-font)',
            color: 'var(--term-mid)',
            borderBottom: '2px solid transparent',
            marginBottom: -1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          Archived
          {archivedCount > 0 && (
            <span
              style={{
                fontFamily: 'var(--ui-font)',
                fontSize: 9.5,
                color: 'var(--term-surface)',
                background: 'var(--term-muted)',
                padding: '0 5px',
                minWidth: 16,
                textAlign: 'center',
                fontWeight: 700,
              }}
            >
              {archivedCount}
            </span>
          )}
        </Tab>
      </div>

      <div>
        {section === 'appearance' && <AppearancePane />}
        {section === 'model' && (
          <ModelPane activeProjectId={activeProject?.id ?? null} />
        )}
        {section === 'notifications' && <NotificationsPane />}
        {section === 'shortcuts' && <ShortcutsPane />}
        {section === 'account' && signedIn && <AccountPane user={session.data!.user} />}

        {section === 'appearance' && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
            <BorderBtn
              onClick={resetTerminal}
              style={{
                padding: '6px 14px',
                border: '1px solid var(--term-line)',
                color: 'var(--term-mid)',
                fontFamily: 'var(--ui-font)',
                fontSize: 11.5,
                background: 'transparent',
              }}
            >
              reset appearance
            </BorderBtn>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountPane({ user }: { user: { email: string; name?: string; image?: string | null } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOutAndReset();
    } catch (err) {
      setBusy(false);
      setError((err as Error).message || 'Sign-out failed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 12 }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>
          signed in as
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {user.image ? (
            <img
              src={user.image}
              alt=""
              width={32}
              height={32}
              style={{ borderRadius: '50%', objectFit: 'cover' }}
            />
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {user.name ? <span style={{ fontWeight: 600 }}>{user.name}</span> : null}
            <span style={{ color: 'var(--term-muted)' }}>{user.email}</span>
          </div>
        </div>
      </div>

      <div>
        <BorderBtn onClick={onSignOut} disabled={busy}>
          {busy ? 'Signing out…' : 'Sign out'}
        </BorderBtn>
        {error && (
          <div style={{ color: 'var(--term-error, #d33)', fontSize: 11, marginTop: 6 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function NotificationsPane() {
  const { prefs, setPref } = usePrefs();

  const NOTIFICATION_OPTIONS: Array<{ value: 'all' | 'approval-only' | 'off'; label: string; desc: string }> = [
    { value: 'all', label: 'All', desc: 'Notify when streaming finishes and on approval requests.' },
    { value: 'approval-only', label: 'Approval only', desc: 'Only notify on permission / approval requests.' },
    { value: 'off', label: 'Off', desc: 'No notifications.' },
  ];

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
        Notifications
      </h1>
      <div style={{ marginBottom: 20 }} />

      <Row k="notifications" label="Notification level">
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
          {NOTIFICATION_OPTIONS.map((o, i) => {
            const sel = prefs.notifications === o.value;
            return (
              <ClickableRow
                key={o.value}
                active={sel}
                onClick={() => setPref('notifications', o.value)}
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
                  borderBottom: i < NOTIFICATION_OPTIONS.length - 1 ? '1px solid var(--term-line)' : 'none',
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: `1px solid ${sel ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--term-surface-glass)',
                  }}
                >
                  {sel && <span style={{ width: 6, height: 6, background: 'var(--term-accent)' }} />}
                </span>
                <div>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontFamily: 'var(--ui-font)',
                      color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
                      fontWeight: sel ? 600 : 400,
                    }}
                  >
                    {o.label}
                  </span>
                  <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginTop: 2 }}>{o.desc}</div>
                </div>
              </ClickableRow>
            );
          })}
        </div>
      </Row>
    </div>
  );
}

type Binding = { keys: string; label: string };
type Group = { title: string; bindings: Binding[] };

const SHORTCUT_GROUPS: Group[] = [
  {
    title: 'Navigation (terminal)',
    bindings: [
      { keys: kbd('mod', 'K'), label: 'Open command palette' },
      { keys: kbd('mod', '1'), label: 'Dashboard page' },
      { keys: kbd('mod', 'M'), label: 'Map page' },
      { keys: kbd('mod', 'D'), label: 'Digest page' },
      { keys: kbd('mod', 'O'), label: 'Workspaces page' },
      { keys: kbd('mod', ','), label: 'Settings page' },
    ],
  },
  {
    title: 'Panes',
    bindings: [
      { keys: kbd('mod', 'W'), label: 'Close focused pane' },
      { keys: kbd('mod', 'T'), label: 'New thread (tree root in current workspace)' },
      { keys: kbd('mod', 'alt', 'T'), label: 'New blank branch from focused pane' },
      { keys: kbd('mod', '\\'), label: 'Open next chat not yet in a pane' },
      { keys: kbd('mod', '1–9'), label: 'Focus pane by tab index' },
      { keys: kbd('ctrl', 'Tab'), label: 'Cycle to next pane (works while typing)' },
      { keys: kbd('ctrl', 'shift', 'Tab'), label: 'Cycle to previous pane' },
    ],
  },
  {
    title: 'Composer',
    bindings: [
      { keys: kbd('enter'), label: 'Send message' },
      { keys: kbd('mod', 'enter'), label: 'Branch — send as a new child chat' },
      { keys: '/fanout a; b; c', label: 'Fan out into N sibling branches' },
      { keys: '/btw <msg>', label: `Branch with this message (alias of ${kbd('mod', 'enter')})` },
    ],
  },
  {
    title: 'Command palette',
    bindings: [
      { keys: '↑ ↓', label: 'Move highlight' },
      { keys: kbd('enter'), label: 'Run selected command' },
      { keys: 'esc', label: 'Close palette' },
    ],
  },
];

function ShortcutsPane() {
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
        Shortcuts
      </h1>
      <div style={{ marginBottom: 20 }} />

      {SHORTCUT_GROUPS.map((g) => (
        <div key={g.title} style={{ marginBottom: 22 }}>
          <div
            style={{
              fontSize: 10,
              color: 'var(--term-muted)',
              letterSpacing: '.14em',
              marginBottom: 8,
              fontFamily: 'var(--ui-font)',
            }}
          >
            ▸ {g.title.toUpperCase()}
          </div>
          <div style={{ border: '1px solid var(--term-line)', background: 'var(--term-surface-glass)' }}>
            {g.bindings.map((b, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr',
                  alignItems: 'center',
                  gap: 12,
                  padding: '8px 14px',
                  borderBottom: i < g.bindings.length - 1 ? '1px solid var(--term-line)' : 'none',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--ui-font)',
                    fontSize: 11,
                    color: 'var(--term-fg)',
                    padding: '2px 6px',
                    border: '1px solid var(--term-line)',
                    background: 'var(--term-alt)',
                    justifySelf: 'start',
                  }}
                >
                  {b.keys}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--ui-font)',
                    fontSize: 12.5,
                    color: 'var(--term-mid)',
                  }}
                >
                  {b.label}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ModelPane({
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
        return active ? (
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
          // Refresh silently — if the new provider has no API key, we don't
          // want the global ApiKeyGate modal to slam over Settings. The
          // inline ProviderKeyControls below already shows a "(missing)"
          // reminder and a key input for the active provider.
          if (typeof window !== 'undefined') {
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
            {p.label}{(p.hasKey ?? false) ? ' - key saved' : ''}
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
  const activeProvider = (status.providers ?? []).find((p) => p.id === status.provider);
  const locked = activeProvider ? providerModelLocked(activeProvider) : false;
  const { models, loading, error: loadError, retry } = useAgentModelCatalog({
    enabled: status.capabilities.models === true,
    runtime: status.runtime,
    provider: status.provider,
  });

  return (
    <div style={{ fontFamily: 'var(--ui-font)', fontSize: 13, color: 'var(--term-fg)', marginBottom: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>model</div>
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
        {models.length === 0 && status.model && (
          <option value={status.model}>{status.model}</option>
        )}
        {models.length === 0 && !status.model && (
          <option value="">{loading ? 'Loading models…' : 'No models available'}</option>
        )}
        {models.map((m) => (
          <option key={m.id} value={m.id}>{m.label || m.id}</option>
        ))}
      </select>
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
    if (!confirm(`Clear the saved ${provider.label} API key?`)) return;
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
        <span
          style={{
            width: 28,
            height: 16,
            border: '1px solid var(--term-line-s)',
            background: enabled ? 'var(--term-accent)' : 'var(--term-surface)',
            position: 'relative',
            display: 'inline-block',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 1,
              left: enabled ? 13 : 1,
              width: 12,
              height: 12,
              background: enabled ? 'var(--term-surface)' : 'var(--term-line-s)',
            }}
          />
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
        <span
          style={{
            width: 28,
            height: 16,
            border: '1px solid var(--term-line-s)',
            background: enabled ? 'var(--term-accent)' : 'var(--term-surface)',
            position: 'relative',
            display: 'inline-block',
            flexShrink: 0,
            marginTop: 1,
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: 1,
              left: enabled ? 13 : 1,
              width: 12,
              height: 12,
              background: enabled ? 'var(--term-surface)' : 'var(--term-line-s)',
            }}
          />
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

const CODE_BLOCK_OPTIONS: Array<{ value: CodeBlockStyle; label: string; desc: string }> = [
  {
    value: 'hairline',
    label: 'Hairline',
    desc: 'No header bar - language sits as a faint mono overline, copy reveals on hover. Quietest.',
  },
  {
    value: 'header',
    label: 'Header rule',
    desc: 'A divider bar carrying a lowercase language label. Classic terminal.',
  },
];

function AppearancePane() {
  const { prefs, setPref } = usePrefs();
  const currentAccent = resolveAccent(prefs.terminalAccentOverrides, prefs.terminalPalette);

  const Swatch = ({
    c,
    label,
    value,
  }: {
    c: string;
    label: string;
    value: TerminalPalette;
  }) => {
    const sel = prefs.terminalPalette === value;
    return (
      <ClickableRow
        active={sel}
        onClick={() => {
          if (sel) {
            // Re-click on the active palette resets its accent override.
            const next = { ...prefs.terminalAccentOverrides };
            delete next[value];
            setPref('terminalAccentOverrides', next);
            return;
          }
          setPref('terminalPalette', value);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          border: sel ? '1px solid var(--term-fg)' : '1px solid var(--term-line)',
          background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            background: c,
            border: '1px solid var(--term-line-s)',
          }}
        />
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--ui-font)',
            color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
          }}
        >
          {label}
        </span>
        {sel && (
          <span
            style={{
              color: 'var(--term-accent)',
              fontSize: 10,
              fontWeight: 700,
              marginLeft: 4,
            }}
          >
            ✓
          </span>
        )}
      </ClickableRow>
    );
  };

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
        Appearance
      </h1>
      <div style={{ marginBottom: 20 }} />

      <Row k="theme.palette" label="Palette">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <Swatch c="#f6f5f1" label="bone" value="bone" />
          <Swatch c="#f3f4f6" label="slate" value="slate" />
          <Swatch c="#272822" label="monokai" value="monokai" />
          <Swatch c="#282828" label="gruvbox" value="gruvbox" />
        </div>
      </Row>

      <Row k="theme.uiFont" label="Interface font">
        <Radio
          opts={['Geist', 'IBM Plex Sans', 'Inter']}
          value={prefs.uiFont}
          onChange={(v) => setPref('uiFont', v as typeof prefs.uiFont)}
        />
      </Row>

      <Row k="theme.messageFont" label="Message font">
        <Radio
          opts={['Source Serif 4', 'Geist']}
          value={prefs.messageFont}
          onChange={(v) => setPref('messageFont', v as typeof prefs.messageFont)}
        />
      </Row>

      <Row k="theme.messageFontSize" label="Message size">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={12}
            max={22}
            step={0.5}
            value={prefs.messageFontSize}
            onChange={(e) => setPref('messageFontSize', Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--term-accent)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
            {prefs.messageFontSize}px
          </span>
        </div>
      </Row>

      <Row k="theme.composerFontSize" label="Composer size">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={12}
            max={22}
            step={0.5}
            value={prefs.composerFontSize}
            onChange={(e) => setPref('composerFontSize', Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--term-accent)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
            {prefs.composerFontSize}px
          </span>
        </div>
      </Row>

      {/* Glass material controls (Sidebar glass / blur / saturation / tint /
          depth + native Sidebar material) are intentionally hidden — the defaults
          in prefs.tsx are the tuned look. The prefs + effects still drive the
          glass; re-add these Rows to expose them again. */}

      <Row k="theme.sidebarDensity" label="Sidebar density">
        <Radio
          opts={['compact', 'comfortable', 'airy']}
          value={prefs.sidebarDensity}
          onChange={(v) => setPref('sidebarDensity', v as any)}
        />
      </Row>

      <Row k="theme.sidebarInset" label="Sidebar edge padding">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={prefs.sidebarInset}
            onChange={(e) => setPref('sidebarInset', Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--term-accent)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
            {prefs.sidebarInset}px
          </span>
        </div>
      </Row>

      <Row k="theme.codeBlock" label="Code block">
        <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
          {CODE_BLOCK_OPTIONS.map((o, i) => {
            const sel = prefs.codeBlockStyle === o.value;
            return (
              <ClickableRow
                key={o.value}
                active={sel}
                onClick={() => setPref('codeBlockStyle', o.value)}
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
                  borderBottom: i < CODE_BLOCK_OPTIONS.length - 1 ? '1px solid var(--term-line)' : 'none',
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: `1px solid ${sel ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--term-surface-glass)',
                    flexShrink: 0,
                  }}
                >
                  {sel && <span style={{ width: 6, height: 6, background: 'var(--term-accent)' }} />}
                </span>
                <div>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontFamily: 'var(--ui-font)',
                      color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
                      fontWeight: sel ? 600 : 400,
                    }}
                  >
                    {o.label}
                  </span>
                  <div style={{ fontSize: 10.5, color: 'var(--term-muted)', marginTop: 2, lineHeight: 1.45 }}>
                    {o.desc}
                  </div>
                </div>
              </ClickableRow>
            );
          })}
        </div>
      </Row>

      <Row k="theme.codeWrap" label="Code wrap">
        <Toggle
          on={prefs.codeWrap}
          label="wrap long lines instead of horizontal scroll"
          onChange={(v) => setPref('codeWrap', v)}
        />
      </Row>

      <Row k="theme.density" label="Density">
        <Radio
          opts={['comfortable', 'compact', 'dense']}
          value={prefs.terminalDensity}
          onChange={(v) => setPref('terminalDensity', v as any)}
        />
      </Row>

      <Row k="theme.focusDim" label="Focus dimming">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={prefs.focusDim}
            onChange={(e) => setPref('focusDim', Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--term-accent)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 30, textAlign: 'right' }}>
            {prefs.focusDim}%
          </span>
        </div>
      </Row>

      {import.meta.env.DEV && (
        <Row k="theme.paneTopFade" label="Pane top fade">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="range"
              min={0}
              max={60}
              step={2}
              value={prefs.paneTopFadeHeight}
              onChange={(e) => setPref('paneTopFadeHeight', Number(e.target.value))}
              style={{ flex: 1, accentColor: 'var(--term-accent)' }}
            />
            <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 38, textAlign: 'right' }}>
              {prefs.paneTopFadeHeight}px
            </span>
          </div>
        </Row>
      )}

      <Row k="layout.paneWidth" label="Default pane width">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={360}
            max={1200}
            step={20}
            value={prefs.defaultPaneWidth}
            onChange={(e) => setPref('defaultPaneWidth', Number(e.target.value))}
            style={{ flex: 1, accentColor: 'var(--term-accent)' }}
          />
          <span style={{ fontSize: 11, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', minWidth: 42, textAlign: 'right' }}>
            {prefs.defaultPaneWidth}px
          </span>
        </div>
      </Row>

      <Row k="layout.singlePaneWidth" label="Single-pane reading width">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="range"
            min={480}
            max={1280}
            step={20}
            value={prefs.singlePaneContentWidth ?? 800}
            disabled={prefs.singlePaneContentWidth === null}
            onChange={(e) => setPref('singlePaneContentWidth', Number(e.target.value))}
            style={{
              flex: 1,
              accentColor: 'var(--term-accent)',
              opacity: prefs.singlePaneContentWidth === null ? 0.4 : 1,
            }}
          />
          <span
            style={{
              fontSize: 11, color: 'var(--term-fg)',
              fontFamily: 'var(--ui-font)', minWidth: 56, textAlign: 'right',
            }}
          >
            {prefs.singlePaneContentWidth === null
              ? 'full'
              : `${prefs.singlePaneContentWidth}px`}
          </span>
          <button
            type="button"
            onClick={() =>
              setPref(
                'singlePaneContentWidth',
                prefs.singlePaneContentWidth === null ? 800 : null,
              )
            }
            style={{
              padding: '4px 9px',
              border: `1px solid ${prefs.singlePaneContentWidth === null ? 'var(--term-fg)' : 'var(--term-line)'}`,
              background: prefs.singlePaneContentWidth === null ? 'var(--term-fg)' : 'transparent',
              color: prefs.singlePaneContentWidth === null ? 'var(--term-surface)' : 'var(--term-mid)',
              fontFamily: 'var(--ui-font)', fontSize: 11, cursor: 'pointer',
            }}
          >
            full width
          </button>
        </div>
      </Row>

      <Row k="theme.rules" label="Chrome rules">
        <Toggle
          on={prefs.paneRules}
          label="hairline rules between panes"
          onChange={(v) => setPref('paneRules', v)}
        />
      </Row>

      <Row k="theme.accent" label="Accent hue">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            ['#b8451f', 'rust'],
            ['#1a4d8f', 'ink'],
            ['#2f6b4e', 'moss'],
            ['#6d4aa8', 'violet'],
            ['#c48300', 'amber'],
            ['#a8261a', 'red'],
            ['#58c6a5', 'mint'],
            ['#10a37f', 'green'],
            ['#c15f3c', 'clay'],
            ['#00d9ff', 'cyan'],
            ['#ff2d95', 'pink'],
          ].map(([c, n]) => {
            const sel = currentAccent === c;
            return (
              <ClickableRow
                key={n}
                active={sel}
                onClick={() =>
                  setPref('terminalAccentOverrides', {
                    ...prefs.terminalAccentOverrides,
                    [prefs.terminalPalette]: c,
                  })
                }
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 8px',
                  border: sel ? '1px solid var(--term-fg)' : '1px solid var(--term-line)',
                  background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
                }}
              >
                <span style={{ width: 14, height: 14, background: c }} />
                <span
                  style={{
                    fontFamily: 'var(--ui-font)',
                    fontSize: 10.5,
                    color: 'var(--term-mid)',
                  }}
                >
                  {n}
                </span>
              </ClickableRow>
            );
          })}
        </div>
      </Row>
    </div>
  );
}

function Row({
  k,
  label,
  children,
}: {
  k: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '12px 0',
        borderBottom: '1px solid var(--term-line)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div
          style={{
            fontFamily: 'var(--ui-font)',
            fontSize: 13,
            color: 'var(--term-fg)',
            fontWeight: 600,
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--term-faint)',
            fontFamily: 'var(--ui-font)',
          }}
        >
          {k}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Radio({
  opts,
  value,
  onChange,
}: {
  opts: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid var(--term-line)' }}>
      {opts.map((o, i) => {
        const sel = o === value;
        return (
          <ClickableRow
            key={o}
            active={sel}
            onClick={() => onChange(o)}
            style={{
              padding: '8px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              background: sel ? 'var(--term-alt)' : 'var(--term-surface)',
              borderBottom: i < opts.length - 1 ? '1px solid var(--term-line)' : 'none',
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                border: `1px solid ${sel ? 'var(--term-accent)' : 'var(--term-line-s)'}`,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'var(--term-surface-glass)',
              }}
            >
              {sel && <span style={{ width: 6, height: 6, background: 'var(--term-accent)' }} />}
            </span>
            <span
              style={{
                fontSize: 11.5,
                fontFamily: 'var(--ui-font)',
                color: sel ? 'var(--term-fg)' : 'var(--term-mid)',
                fontWeight: sel ? 600 : 400,
              }}
            >
              {o}
            </span>
          </ClickableRow>
        );
      })}
    </div>
  );
}

function Toggle({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <ClickableRow
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 6px',
        margin: '0 -6px',
      }}
      onClick={() => onChange(!on)}
    >
      <span
        style={{
          width: 28,
          height: 16,
          border: '1px solid var(--term-line-s)',
          background: on ? 'var(--term-accent)' : 'var(--term-surface)',
          position: 'relative',
          display: 'inline-block',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: on ? 13 : 1,
            width: 12,
            height: 12,
            background: on ? 'var(--term-surface)' : 'var(--term-line-s)',
          }}
        />
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--term-mid)', fontFamily: 'var(--ui-font)' }}>
        {label}
      </span>
    </ClickableRow>
  );
}
