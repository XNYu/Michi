import React, { useEffect, useMemo, useState } from 'react';
import type { PageId } from '../../../state/commands';
import { authClient } from '../../../services/auth';
import { signOutAndReset } from '../../../services/signOut';
import { useChatStore, useNodesSelector } from '../../../state/chatStore';
import { usePrefs, type TerminalPalette } from '../../../state/prefs';
import {
  saveProviderKey,
  clearProviderKey,
  fetchAgentStatus,
  type AgentStatus,
  type AgentProviderInfo,
} from '../../../services/api';
import {
  buildProfileActivity,
  type ActivityMetric,
  type ProfileActivity,
} from './profileActivity';
import { providerRequiresUserKey } from '../../../lib/providerCapabilities';
import { confirmDialog } from '../../ui/ConfirmDialog';

/**
 * Profile page — implementation of the Claude-Design profile.html mock.
 *
 * Wired to the real backend where it makes sense:
 *   - Google identity comes from better-auth's session.
 *   - Provider list + hasKey come from /api/agent/status; add/remove keys
 *     uses /api/agent/provider-key.
 *   - Theme swatches drive prefs.terminalPalette.
 *   - Sign-out hits authClient.signOut() and reloads to drop the cookie.
 *
 * The heatmap is derived from persisted local chat activity. The usage card
 * still shows illustrative numbers — the backend has no per-user usage
 * telemetry yet.
 */
export default function ProfilePage({ onNav }: { onNav?: (p: PageId) => void } = {}) {
  const session = authClient.useSession();
  const user = session.data?.user;
  const { prefs, setPref } = usePrefs();
  const { projects } = useChatStore();
  const activity = useNodesSelector(
    React.useCallback((nodes) => buildProfileActivity(projects, nodes), [projects]),
  );

  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const refreshAgent = React.useCallback(() => {
    fetchAgentStatus()
      .then(setAgentStatus)
      .catch(() => setAgentStatus(null));
  }, []);
  useEffect(() => { refreshAgent(); }, [refreshAgent]);

  const initials = useMemo(() => deriveInitials(user?.name, user?.email), [user?.name, user?.email]);

  const onSignOut = async () => {
    await signOutAndReset();
  };

  return (
    <div
      className="profile-page term-scrollbar"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        background: 'var(--term-page-bg, var(--term-bg))',
        color: 'var(--fg, var(--term-fg))',
      }}
    >
      <ProfilePageStyles />

      <div className="profile-shell">
        <SideNav onNav={onNav} providerCount={agentStatus?.providers?.filter((p) => p.hasKey).length ?? 0} />

        <section className="profile-main">
          <ProfileHero
            name={user?.name || 'Signed-in user'}
            email={user?.email || ''}
            image={user?.image ?? null}
            initials={initials}
            onSignOut={() => void onSignOut()}
          />

          <HeatmapCard activity={activity} />

          <UsageCard />

          <ApiKeysSection status={agentStatus} onChanged={refreshAgent} />

          <AccountSettings
            displayName={user?.name || ''}
            email={user?.email || ''}
            palette={prefs.terminalPalette}
            onPaletteChange={(p) => setPref('terminalPalette', p)}
          />

          <footer className="profile-footer">
            <span>michi · <a href="#" onClick={(e) => { e.preventDefault(); onNav?.('home'); }}>home</a></span>
            <nav>
              <a href="#" onClick={(e) => { e.preventDefault(); onNav?.('dashboard'); }}>dashboard</a>
              <a href="#" onClick={(e) => { e.preventDefault(); onNav?.('settings'); }}>settings</a>
              <a href="#" onClick={(e) => { e.preventDefault(); void onSignOut(); }}>sign out</a>
            </nav>
          </footer>
        </section>
      </div>
    </div>
  );
}

// ─── side nav ──────────────────────────────────────────────────────────────

function SideNav({
  onNav,
  providerCount,
}: {
  onNav?: (p: PageId) => void;
  providerCount: number;
}) {
  return (
    <aside className="profile-sidenav">
      <div className="profile-sidenav__section">
        <h4>account</h4>
        <div className="profile-sidenav__items">
          <a className="profile-sidenav__item is-active" href="#">
            <span className="profile-sidenav__caret">▸</span>
            <UserIcon /> <span>overview</span>
          </a>
          <a className="profile-sidenav__item" href="#" onClick={(e) => { e.preventDefault(); onNav?.('settings'); }}>
            <span className="profile-sidenav__caret" />
            <SettingsGearIcon /> <span>profile &amp; settings</span>
          </a>
          <a className="profile-sidenav__item" href="#a-keys">
            <span className="profile-sidenav__caret" />
            <KeyIcon /> <span>api keys</span>
            <span className="profile-sidenav__count">{providerCount}</span>
          </a>
          <a className="profile-sidenav__item" href="#a-usage">
            <span className="profile-sidenav__caret" />
            <ChartIcon /> <span>usage</span>
          </a>
        </div>
      </div>

      <div className="profile-sidenav__section">
        <h4>workspace</h4>
        <div className="profile-sidenav__items">
          <a className="profile-sidenav__item" href="#" onClick={(e) => { e.preventDefault(); onNav?.('workspaces'); }}>
            <span className="profile-sidenav__caret" />
            <BranchIcon /> <span>workspaces</span>
          </a>
          <a className="profile-sidenav__item" href="#" onClick={(e) => { e.preventDefault(); onNav?.('dashboard'); }}>
            <span className="profile-sidenav__caret" />
            <ChatIcon /> <span>threads</span>
          </a>
          <a className="profile-sidenav__item" href="#" onClick={(e) => { e.preventDefault(); onNav?.('digest'); }}>
            <span className="profile-sidenav__caret" />
            <BookIcon /> <span>library</span>
          </a>
        </div>
      </div>

      <div className="profile-sidenav__section">
        <h4>data</h4>
        <div className="profile-sidenav__items">
          <a className="profile-sidenav__item" href="#" onClick={(e) => { e.preventDefault(); onNav?.('settings'); }}>
            <span className="profile-sidenav__caret" />
            <DownloadIcon /> <span>export data</span>
          </a>
          <a className="profile-sidenav__item" href="#" onClick={(e) => { e.preventDefault(); onNav?.('trash'); }}>
            <span className="profile-sidenav__caret" />
            <TrashIcon /> <span>trash</span>
          </a>
          <a className="profile-sidenav__item" href="#" onClick={(e) => { e.preventDefault(); onNav?.('archived'); }}>
            <span className="profile-sidenav__caret" />
            <span style={{ display: 'inline-flex', width: 16, justifyContent: 'center' }}>▣</span> <span>archived</span>
          </a>
        </div>
      </div>
    </aside>
  );
}

// ─── hero ──────────────────────────────────────────────────────────────────

function ProfileHero({
  name,
  email,
  image,
  initials,
  onSignOut,
}: {
  name: string;
  email: string;
  image: string | null;
  initials: string;
  onSignOut: () => void;
}) {
  return (
    <header className="phero">
      {image ? (
        <img className="phero__avatar phero__avatar--img" src={image} alt={name} />
      ) : (
        <span className="phero__avatar phero__avatar--initials" aria-hidden>{initials}</span>
      )}
      <div className="phero__info">
        <h1 className="phero__name">{name}</h1>
        <div className="phero__meta">
          {email && (
            <>
              <span className="phero__field"><span className="phero__k">user</span><span className="phero__v">{email}</span></span>
              <span className="phero__sep">│</span>
            </>
          )}
          <span className="phero__field"><span className="phero__k">joined</span><span className="phero__v">Mar 2025</span></span>
          <span className="phero__sep">│</span>
          <span className="phero__field"><span className="phero__k">tz</span><span className="phero__v">UTC{deviceUtcOffset()} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></span>
        </div>
      </div>
      <div className="phero__right">
        <div className="phero__streak">
          <span className="phero__streak-dot" />
          <span>streak <b>18d</b></span>
        </div>
        <button
          type="button"
          className="phero__signout"
          onClick={onSignOut}
        >
          sign out
        </button>
      </div>
    </header>
  );
}

function deviceUtcOffset(): string {
  const m = -new Date().getTimezoneOffset();
  const sign = m >= 0 ? '+' : '−';
  const hours = Math.floor(Math.abs(m) / 60);
  return `${sign}${hours}`;
}

function deriveInitials(name?: string | null, email?: string | null): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return 'ME';
}

// ─── heatmap ───────────────────────────────────────────────────────────────

function HeatmapCard({ activity }: { activity: ProfileActivity }) {
  const [metric, setMetric] = useState<ActivityMetric>('nodes');
  const summary = activity.metrics[metric];
  const cells = summary.cells;
  const longest = summary.longestStreak;
  const current = summary.currentStreak;

  return (
    <div className="heatmap-card">
      <div className="heatmap-card__top">
        <div className="heatmap-card__title">
          <h3>activity</h3>
          <em>{formatCompact(activity.totalNodes)} nodes · {formatCompact(activity.totalThreads)} threads</em>
        </div>
        <div className="seg-toggle" role="tablist" aria-label="Heatmap metric">
          <MetricButton metric="nodes" activeMetric={metric} onSelect={setMetric}>nodes</MetricButton>
          <MetricButton metric="branches" activeMetric={metric} onSelect={setMetric}>branches</MetricButton>
          <MetricButton metric="tokens" activeMetric={metric} onSelect={setMetric}>tokens</MetricButton>
        </div>
      </div>

      <div className="heatmap">
        <div className="heatmap__day-labels" aria-hidden>
          <span>S</span><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span>
        </div>
        <div className="heatmap__main">
          <div className="heatmap__grid" role="img" aria-label="Activity heatmap, last 53 weeks">
            {cells.map((cell) => (
              <span
                key={cell.dateKey}
                className={`heatmap__cell l${cell.level}${cell.isFuture ? ' is-future' : ''}`}
                title={`${cell.dateKey}: ${formatMetricCount(cell.count, metric)}`}
              />
            ))}
          </div>
        </div>
      </div>

      <div className="heatmap__legend">
        <span>
          {summary.total > 0
            ? `${formatMetricCount(summary.total, metric)} in the last year`
            : `No ${metricLabel(metric)} yet`}
          {' '}·{' '}
          longest streak <b style={{ color: 'var(--fg)' }}>{longest} days</b>
          {current > 0 && (
            <>
              {' '}· current <b style={{ color: 'var(--fg)' }}>{current} days</b>
            </>
          )}
        </span>
        <div className="heatmap__legend-scale">
          <span>less</span>
          <span className="heatmap__cell l0" />
          <span className="heatmap__cell l1" />
          <span className="heatmap__cell l2" />
          <span className="heatmap__cell l3" />
          <span className="heatmap__cell l4" />
          <span>more</span>
        </div>
      </div>
    </div>
  );
}

function MetricButton({
  metric,
  activeMetric,
  onSelect,
  children,
}: {
  metric: ActivityMetric;
  activeMetric: ActivityMetric;
  onSelect: (metric: ActivityMetric) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={activeMetric === metric ? 'is-active' : ''}
      aria-pressed={activeMetric === metric}
      onClick={() => onSelect(metric)}
    >
      {children}
    </button>
  );
}

function metricLabel(metric: ActivityMetric): string {
  if (metric === 'tokens') return 'estimated tokens';
  if (metric === 'branches') return 'branches';
  return 'nodes';
}

function formatMetricCount(value: number, metric: ActivityMetric): string {
  const formatted = formatCompact(value);
  if (metric === 'tokens') return `${formatted} est. tokens`;
  if (metric === 'branches') return `${formatted} ${value === 1 ? 'branch' : 'branches'}`;
  return `${formatted} ${value === 1 ? 'node' : 'nodes'}`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

// ─── model usage ───────────────────────────────────────────────────────────

function UsageCard() {
  return (
    <div className="usage-card" id="a-usage">
      <p className="usage-card__label">Tokens by model · 30d</p>
      <div className="usage-bar" role="img" aria-label="Token usage by model — illustrative only">
        <span className="usage-bar__seg" style={{ width: '46%', background: '#b85d17' }} />
        <span className="usage-bar__seg" style={{ width: '24%', background: '#2f6b4e' }} />
        <span className="usage-bar__seg" style={{ width: '18%', background: '#6d4aa8' }} />
        <span className="usage-bar__seg" style={{ width: '12%', background: '#c48300' }} />
      </div>
      <div className="usage-list">
        <UsageRow color="#b85d17" name="claude-sonnet-4-5" toks="3.86M tok" pct="46%" />
        <UsageRow color="#2f6b4e" name="gpt-5" toks="2.02M tok" pct="24%" />
        <UsageRow color="#6d4aa8" name="claude-opus-4-5" toks="1.51M tok" pct="18%" />
        <UsageRow color="#c48300" name="deepseek-v3 · via OpenRouter" toks="1.01M tok" pct="12%" />
      </div>
    </div>
  );
}

function UsageRow({ color, name, toks, pct }: { color: string; name: string; toks: string; pct: string }) {
  return (
    <div className="usage-row">
      <span className="usage-row__swatch" style={{ background: color }} />
      <span className="usage-row__name">{name}</span>
      <span className="usage-row__tokens">{toks}</span>
      <span className="usage-row__pct">{pct}</span>
    </div>
  );
}

// ─── api keys ──────────────────────────────────────────────────────────────

function ApiKeysSection({
  status,
  onChanged,
}: {
  status: AgentStatus | null;
  onChanged: () => void;
}) {
  const providers = status?.providers ?? [];
  const saved = providers.filter((p) => p.hasKey);
  const missing = providers.filter((p) => !p.hasKey);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const pending = pendingId ? missing.find((p) => p.id === pendingId) ?? null : null;

  const onAddSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (id) setPendingId(id);
    e.target.value = '';
  };

  const handleChanged = () => {
    setPendingId(null);
    onChanged();
  };

  return (
    <div className="profile-section" id="a-keys">
      <div className="profile-section__head">
        <h2>api keys</h2>
        <span className="profile-section__meta">
          stored encrypted · used only when you select the provider
        </span>
      </div>

      {providers.length === 0 ? (
        <div className="profile-empty">no providers configured.</div>
      ) : (
        <>
          {(saved.length > 0 || pending) && (
            <div className="keys">
              {saved.map((p) => <KeyRow key={p.id} provider={p} onChanged={handleChanged} />)}
              {pending && (
                <KeyRow
                  key={`pending-${pending.id}`}
                  provider={pending}
                  onChanged={handleChanged}
                  onCancel={() => setPendingId(null)}
                  startEditing
                />
              )}
            </div>
          )}

          {missing.length > 0 && !pending && (
            <div className="keys-add">
              <label className="keys-add__label">add provider</label>
              <select className="keys-add__select" onChange={onAddSelect} defaultValue="">
                <option value="" disabled>
                  {saved.length === 0 ? 'select a provider to add…' : 'add another provider…'}
                </option>
                {missing.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const PROVIDER_ICON_CLASS: Record<string, string> = {
  anthropic: 'key-row__icon--anthropic',
  openai: 'key-row__icon--openai',
  openrouter: 'key-row__icon--openrouter',
  google: 'key-row__icon--google',
  vertex: 'key-row__icon--google',
};

function KeyRow({
  provider,
  onChanged,
  onCancel,
  startEditing = false,
}: {
  provider: AgentProviderInfo;
  onChanged: () => void;
  onCancel?: () => void;
  startEditing?: boolean;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iconClass = PROVIDER_ICON_CLASS[provider.id] ?? 'key-row__icon--anthropic';
  const iconChar = provider.label.charAt(0).toUpperCase();

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    const res = await saveProviderKey(provider.id, key);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setDraft('');
    setEditing(false);
    onChanged();
  };

  const remove = async () => {
    if (!(await confirmDialog({
      title: 'Clear API key',
      message: `Clear the saved ${provider.label} API key?`,
      confirmLabel: 'Clear',
    }))) return;
    setBusy(true);
    setError(null);
    const res = await clearProviderKey(provider.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onChanged();
  };

  const envLabel = provider.envVars.join(', ') || provider.keyLabel;

  return (
    <div className={`key-row ${provider.hasKey ? 'is-saved' : 'is-missing'}`}>
      <span className={`key-row__icon ${iconClass}`}>{iconChar}</span>
      <div className="key-row__info">
        <div className="key-row__name">
          <span className="key-row__label">{provider.label}</span>
          <span className={`key-row__tag ${provider.hasKey ? 'is-ok' : 'is-muted'}`}>
            [{provider.hasKey ? 'saved' : 'missing'}]
          </span>
          {envLabel && <span className="key-row__env">{envLabel}</span>}
        </div>
        <div className="key-row__sub">
          {editing || !provider.hasKey ? (
            <span className="key-row__editor">
              <span className="key-row__prompt">$</span>
              <input
                autoFocus
                type="password"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save();
                  if (e.key === 'Escape') {
                    setEditing(false); setDraft(''); setError(null);
                    onCancel?.();
                  }
                }}
                placeholder={provider.keyLabel || `paste ${provider.label} api key…`}
                disabled={busy}
                className="key-row__input"
              />
              <button
                type="button"
                className="profile-btn profile-btn--sm"
                disabled={!draft.trim() || busy}
                onClick={() => void save()}
              >
                {busy ? 'saving…' : 'save'}
              </button>
              {(provider.hasKey || editing || onCancel) && (
                <button
                  type="button"
                  className="profile-btn profile-btn--sm profile-btn--ghost"
                  onClick={() => {
                    setEditing(false); setDraft(''); setError(null);
                    onCancel?.();
                  }}
                >
                  cancel
                </button>
              )}
            </span>
          ) : (
            <>
              <code>sk-•••••••••••••••••••stored</code>
              {provider.keyUrl && (
                <> <span className="key-row__sep">·</span> <a className="key-row__link" href={provider.keyUrl} target="_blank" rel="noopener noreferrer">key console ↗</a></>
              )}
            </>
          )}
        </div>
        {error && <div className="key-row__error">{error}</div>}
      </div>
      <div className="key-row__actions">
        {provider.hasKey && !editing && (
          <>
            <button type="button" className="icon-btn" aria-label="Replace" onClick={() => { setEditing(true); setDraft(''); }}>
              <RotateIcon />
            </button>
            <button type="button" className="icon-btn icon-btn--danger" aria-label="Remove" onClick={() => void remove()} disabled={busy}>
              <TrashSmallIcon />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── account settings ──────────────────────────────────────────────────────

const PALETTE_SWATCHES: Array<{ id: TerminalPalette; title: string; from: string; to: string }> = [
  { id: 'bone',    title: 'Bone',    from: '#fdfdfc', to: '#b8451f' },
  { id: 'slate',   title: 'Slate',   from: '#f3f4f6', to: '#1a4d8f' },
  { id: 'monokai', title: 'Monokai', from: '#272822', to: '#a6e22e' },
  { id: 'gruvbox', title: 'Gruvbox', from: '#282828', to: '#fabd2f' },
];

function AccountSettings({
  displayName,
  email,
  palette,
  onPaletteChange,
}: {
  displayName: string;
  email: string;
  palette: TerminalPalette;
  onPaletteChange: (p: TerminalPalette) => void;
}) {
  const [draftName, setDraftName] = useState(displayName);
  useEffect(() => { setDraftName(displayName); }, [displayName]);

  return (
    <div className="profile-section">
      <div className="profile-section__head">
        <h2>account settings</h2>
        <span className="profile-section__meta">theme persists locally · name comes from google</span>
      </div>

      <div className="form-grid">
        <div className="form-row">
          <div>
            <div className="form-row__label">display name</div>
            <div className="form-row__hint">provided by your google account · cannot be edited here</div>
          </div>
          <div className="form-row__control">
            <input className="profile-input profile-input--readonly" type="text" value={draftName} readOnly />
          </div>
          <div />
        </div>

        <div className="form-row">
          <div>
            <div className="form-row__label">email</div>
            <div className="form-row__hint">verified via google · cannot be changed</div>
          </div>
          <div className="form-row__control">
            <input className="profile-input profile-input--readonly" type="email" value={email} readOnly />
          </div>
          <div />
        </div>

        <div className="form-row">
          <div>
            <div className="form-row__label">connected accounts</div>
            <div className="form-row__hint">used for sign-in only — no read/write scopes</div>
          </div>
          <div className="form-row__control">
            <span className="google-pill">
              <GoogleGlyph />
              <span>google{email && <> · {email}</>}</span>
              <span className="google-pill__check">[verified]</span>
            </span>
          </div>
          <div>
            <button
              className="profile-btn profile-btn--sm profile-btn--ghost"
              onClick={signOutAndReset}
            >
              sign out
            </button>
          </div>
        </div>

        <div className="form-row">
          <div>
            <div className="form-row__label">theme</div>
            <div className="form-row__hint">applies to the terminal canvas immediately</div>
          </div>
          <div className="form-row__control">
            <div className="theme-picker">
              {PALETTE_SWATCHES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  title={s.title}
                  aria-label={`Theme: ${s.title}`}
                  aria-pressed={palette === s.id}
                  className={`theme-swatch ${palette === s.id ? 'is-active' : ''}`}
                  style={{ background: `linear-gradient(135deg, ${s.from} 50%, ${s.to} 50%)` }}
                  onClick={() => onPaletteChange(s.id)}
                />
              ))}
            </div>
          </div>
          <div />
        </div>
      </div>
    </div>
  );
}

// ─── inline icons ─────────────────────────────────────────────────────────

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
function UserIcon()        { return <svg viewBox="0 0 24 24" {...stroke}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>; }
function SettingsGearIcon(){ return <svg viewBox="0 0 24 24" {...stroke}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>; }
function KeyIcon()         { return <svg viewBox="0 0 24 24" {...stroke}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>; }
function ChartIcon()       { return <svg viewBox="0 0 24 24" {...stroke}><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>; }
function BranchIcon()      { return <svg viewBox="0 0 24 24" {...stroke}><circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6h6a3 3 0 0 1 3 3v3"/><path d="M7 18h6a3 3 0 0 0 3-3v0"/></svg>; }
function ChatIcon()        { return <svg viewBox="0 0 24 24" {...stroke}><path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>; }
function BookIcon()        { return <svg viewBox="0 0 24 24" {...stroke}><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M4 19a2 2 0 0 0 2 2h14"/></svg>; }
function DownloadIcon()    { return <svg viewBox="0 0 24 24" {...stroke}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>; }
function TrashIcon()       { return <svg viewBox="0 0 24 24" {...stroke}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>; }
function RotateIcon()      { return <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>; }
function TrashSmallIcon()  { return <svg width="14" height="14" viewBox="0 0 24 24" {...stroke}><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>; }

function GoogleGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z" />
    </svg>
  );
}

// ─── styles (scoped under .profile-page) ──────────────────────────────────

function ProfilePageStyles() {
  return (
    <style>{`
      .profile-page {
        --app-bg: var(--term-page-bg, var(--term-bg, #fdfdfc));
        --app-bg-muted: var(--term-bg-muted, var(--term-alt, #ede9e4));
        --surface: var(--term-surface, #ffffff);
        --surface-alt: var(--term-alt, #ede9e4);
        --surface-hover: var(--term-hover-bg, var(--term-alt, #f3f0eb));
        --fg: var(--term-fg, #1c1917);
        --fg-muted: var(--term-muted, #78716c);
        --fg-subtle: var(--term-faint, #c4bdb7);
        --line: var(--term-line, #e7e3de);
        --line-strong: var(--term-line-s, #d6d0ca);
        --accent: var(--term-accent, #b85d17);
        --accent-fg: var(--term-accent-fg, #ffffff);
        --accent-soft: var(--term-accent-f, #f4dccf);
        --accent-tint: var(--term-accent-f, #fef3db);
        --digest: var(--term-digest, #2f6b4e);
        --digest-f: var(--term-digest-f, #d7e7df);
        --danger: var(--term-danger, #a8261a);
        --ok: var(--term-ok, #2f6b4e);
      }

      .profile-shell {
        display: grid;
        grid-template-columns: 220px 1fr;
        max-width: 1280px;
        margin: 0 auto;
        width: 100%;
        padding: 24px 32px 0;
        gap: 36px;
      }
      @media (max-width: 880px) {
        .profile-shell { grid-template-columns: 1fr; gap: 18px; padding: 14px 16px 0; }
        .profile-sidenav { position: static; height: auto; padding: 8px 0 0; }
      }

      /* sidenav — sharp, left-accent active state */
      .profile-sidenav { padding: 14px 0; position: sticky; top: 0; align-self: start; display: flex; flex-direction: column; gap: 22px; }
      .profile-sidenav h4 {
        font-size: 10px; letter-spacing: .18em; text-transform: uppercase;
        color: var(--fg-subtle); font-weight: 500; margin: 0 0 6px 4px;
        font-family: var(--ui-font);
      }
      .profile-sidenav__items { display: flex; flex-direction: column; }
      .profile-sidenav__item {
        display: flex; align-items: center; gap: 9px; padding: 5px 8px 5px 4px;
        font-family: var(--ui-font); font-size: 12.5px;
        color: var(--fg-muted); cursor: pointer;
        transition: background var(--t-quick), color var(--t-quick);
        text-decoration: none;
        border-left: 2px solid transparent;
      }
      .profile-sidenav__item:hover { background: var(--surface-hover); color: var(--fg); }
      .profile-sidenav__item.is-active {
        background: var(--surface-alt); color: var(--fg);
        border-left-color: var(--accent);
      }
      .profile-sidenav__caret {
        width: 8px; color: var(--accent); font-size: 10px;
        display: inline-block; text-align: center;
      }
      .profile-sidenav__item svg { width: 14px; height: 14px; opacity: 0.85; flex-shrink: 0; }
      .profile-sidenav__count {
        margin-left: auto; font-size: 10px; color: var(--fg-subtle);
        font-variant-numeric: tabular-nums;
        padding: 0 4px; border: 1px solid var(--line);
      }
      .profile-sidenav__item.is-active .profile-sidenav__count {
        color: var(--accent); border-color: var(--accent-soft); background: var(--accent-soft);
      }

      .profile-main { padding: 8px 0 80px; min-width: 0; }

      /* hero — square monogram tile, k/v meta */
      .phero {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 18px;
        align-items: center;
        padding-bottom: 22px;
        border-bottom: 1px solid var(--line);
      }
      .phero__avatar {
        width: 56px; height: 56px;
        object-fit: cover;
        position: relative;
      }
      .phero__avatar--img {
        border: 1px solid var(--line);
      }
      .phero__avatar--initials {
        display: inline-flex; align-items: center; justify-content: center;
        background: var(--accent); color: var(--accent-fg);
        font-family: var(--ui-font); font-weight: 600; font-size: 20px;
        letter-spacing: .02em;
      }
      .phero__avatar--initials::after {
        content: ''; position: absolute; inset: 3px;
        border: 1px solid color-mix(in srgb, var(--app-bg) 30%, transparent);
        pointer-events: none;
      }
      .phero__info { min-width: 0; }
      .phero__name {
        font-family: var(--ui-font);
        font-size: 22px; font-weight: 500; letter-spacing: -.01em;
        color: var(--fg); margin: 0 0 6px; line-height: 1.15;
      }
      .phero__meta {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        font-family: var(--ui-font); font-size: 12px; color: var(--fg-muted);
      }
      .phero__field { display: inline-flex; align-items: baseline; gap: 6px; }
      .phero__k {
        color: var(--fg-subtle); font-size: 10.5px;
        letter-spacing: .08em; text-transform: uppercase;
      }
      .phero__v { color: var(--fg); }
      .phero__sep { color: var(--fg-subtle); }
      .phero__right {
        display: inline-flex; align-items: center; gap: 10px;
        flex-shrink: 0;
      }
      .phero__streak {
        display: inline-flex; align-items: center; gap: 7px;
        padding: 5px 9px;
        border: 1px solid var(--accent-soft); background: var(--accent-soft);
        color: var(--accent);
        font-family: var(--ui-font); font-size: 11px; white-space: nowrap;
      }
      .phero__streak b { color: var(--fg); font-weight: 500; }
      .phero__streak-dot {
        width: 6px; height: 6px;
        border-radius: 99px; /* the only intentional radius */
        background: var(--accent);
      }
      .phero__signout {
        background: transparent; color: var(--fg-muted);
        border: 1px solid var(--line);
        padding: 5px 12px;
        font-family: var(--ui-font); font-size: 11px;
        letter-spacing: .04em;
        cursor: pointer; white-space: nowrap;
        transition: color .12s, border-color .12s, background .12s;
      }
      .phero__signout:hover {
        color: var(--accent); border-color: var(--accent);
      }

      /* heatmap — flush in page, square cells, color-mix from accent */
      .heatmap-card { margin-top: 28px; }
      .heatmap-card__top {
        display: flex; align-items: baseline; gap: 16px;
        flex-wrap: wrap; margin-bottom: 16px;
      }
      .heatmap-card__title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; flex: 1; }
      .heatmap-card__title h3 {
        font-family: var(--ui-font); font-size: 12px; font-weight: 600;
        letter-spacing: .16em; text-transform: uppercase;
        margin: 0; color: var(--fg); white-space: nowrap;
        display: flex; align-items: center; gap: 10px;
      }
      .heatmap-card__title h3::before {
        content: ''; display: inline-block;
        width: 4px; height: 12px; background: var(--accent);
      }
      .heatmap-card__title em {
        font-family: var(--ui-font); font-style: normal;
        font-size: 11.5px; color: var(--fg-muted);
      }
      .seg-toggle {
        display: inline-flex;
        border: 1px solid var(--line);
        background: var(--app-bg-muted);
      }
      .seg-toggle button {
        border: 0; background: transparent;
        font-family: var(--ui-font); font-size: 11px;
        color: var(--fg-muted); padding: 5px 12px; cursor: pointer;
        border-right: 1px solid var(--line);
        text-transform: lowercase; letter-spacing: .02em;
        transition: color var(--t-quick), background var(--t-quick);
      }
      .seg-toggle button:last-child { border-right: 0; }
      .seg-toggle button:hover { color: var(--fg); }
      .seg-toggle button.is-active {
        background: var(--fg); color: var(--app-bg);
      }
      .heatmap { display: grid; grid-template-columns: 28px 1fr; gap: 6px; align-items: start; }
      .heatmap__day-labels {
        display: grid; grid-template-rows: repeat(7, 1fr);
        font-family: var(--ui-font); font-size: 10px; color: var(--fg-subtle);
      }
      .heatmap__day-labels span:nth-child(odd) { visibility: hidden; }
      .heatmap__day-labels span { height: 13px; line-height: 13px; }
      .heatmap__main { overflow-x: auto; padding-bottom: 2px; }
      .heatmap__grid {
        display: grid; grid-auto-flow: column;
        grid-template-rows: repeat(7, 12px); grid-auto-columns: 12px;
        gap: 3px; min-width: 700px;
      }
      .heatmap__cell {
        width: 12px; height: 12px;
        background: var(--surface-alt);
        transition: outline var(--t-quick);
      }
      .heatmap__cell:hover {
        outline: 1px solid var(--accent); outline-offset: 1px;
        position: relative; z-index: 2;
      }
      .heatmap__cell.l0 { background: color-mix(in srgb, var(--line) 70%, var(--app-bg)); }
      .heatmap__cell.l1 { background: color-mix(in srgb, var(--accent) 22%, var(--app-bg-muted)); }
      .heatmap__cell.l2 { background: color-mix(in srgb, var(--accent) 45%, var(--app-bg-muted)); }
      .heatmap__cell.l3 { background: color-mix(in srgb, var(--accent) 70%, var(--app-bg)); }
      .heatmap__cell.l4 { background: var(--accent); }
      .heatmap__cell.is-future { opacity: 0.25; }
      .heatmap__legend {
        display: flex; justify-content: space-between; align-items: center;
        margin-top: 10px; font-family: var(--ui-font); font-size: 11px; color: var(--fg-muted);
        flex-wrap: wrap; gap: 8px;
      }
      .heatmap__legend b { color: var(--fg); font-weight: 500; }
      .heatmap__legend-scale {
        display: flex; align-items: center; gap: 4px;
        font-size: 10.5px; color: var(--fg-subtle);
      }
      .heatmap__legend-scale .heatmap__cell { width: 11px; height: 11px; }

      /* usage — sharp bar, dotted rule rows */
      .usage-card { margin-top: 18px; }
      .usage-card__label {
        font-family: var(--ui-font); font-size: 10.5px;
        letter-spacing: .06em; text-transform: uppercase; color: var(--fg-muted);
        margin: 0 0 12px;
      }
      .usage-bar {
        display: flex; height: 10px;
        background: var(--surface-alt); border: 1px solid var(--line);
        margin-bottom: 14px;
      }
      .usage-bar__seg { height: 100%; }
      .usage-list { display: grid; gap: 8px; font-size: 12.5px; }
      .usage-row {
        display: grid; grid-template-columns: 12px auto 1fr auto auto;
        gap: 12px; align-items: center; font-family: var(--ui-font); min-width: 0;
      }
      .usage-row__swatch { width: 10px; height: 10px; }
      .usage-row__name {
        color: var(--fg); font-weight: 500; min-width: 0;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .usage-row::after {
        content: ''; height: 1px;
        background-image: repeating-linear-gradient(to right, var(--line), var(--line) 2px, transparent 2px, transparent 5px);
        grid-column: 3;
      }
      .usage-row__tokens { color: var(--fg-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .usage-row__pct { color: var(--fg-muted); font-variant-numeric: tabular-nums; min-width: 36px; text-align: right; }

      /* sections — uppercase header w/ accent bar */
      .profile-section { margin-top: 28px; padding-top: 28px; border-top: 1px solid var(--line); scroll-margin-top: 24px; }
      .profile-section__head {
        display: flex; align-items: baseline; gap: 16px;
        flex-wrap: wrap; margin-bottom: 16px;
      }
      .profile-section__head h2 {
        font-family: var(--ui-font); font-size: 12px; font-weight: 600;
        letter-spacing: .16em; text-transform: uppercase;
        margin: 0; color: var(--fg); white-space: nowrap;
        display: flex; align-items: center; gap: 10px;
      }
      .profile-section__head h2::before {
        content: ''; display: inline-block;
        width: 4px; height: 12px; background: var(--accent);
      }
      .profile-section__meta {
        font-family: var(--ui-font); font-size: 11.5px; color: var(--fg-muted);
        flex: 1; min-width: 0;
      }
      .profile-section__count {
        font-size: 11px; color: var(--fg-subtle);
        font-variant-numeric: tabular-nums;
        padding: 2px 8px; border: 1px solid var(--line);
        font-family: var(--ui-font);
      }

      .profile-empty {
        padding: 22px; background: var(--surface);
        border: 1px solid var(--line);
        font-family: var(--ui-font); font-size: 12.5px; color: var(--fg-muted);
        text-align: center;
      }

      /* api keys — single sharp stack, [saved]/[missing] tag, $ prompt */
      .keys {
        display: flex; flex-direction: column;
        border: 1px solid var(--line); background: var(--surface);
      }
      .keys-add {
        display: flex; align-items: center; gap: 12px;
        margin-top: 12px;
      }
      .keys-add__label {
        font-family: var(--ui-font); font-size: 11px;
        letter-spacing: .04em; text-transform: uppercase;
        color: var(--fg-subtle);
      }
      .keys-add__select {
        flex: 1; min-width: 0;
        background: var(--surface); color: var(--fg);
        border: 1px solid var(--line);
        padding: 8px 10px;
        font-family: var(--ui-font); font-size: 12.5px;
        cursor: pointer;
      }
      .keys-add__select:hover { border-color: var(--accent); }
      .keys-add__select:focus { outline: none; border-color: var(--accent); }
      .key-row {
        display: grid; grid-template-columns: 36px 1fr auto;
        gap: 14px; align-items: center;
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
      }
      .key-row:last-child { border-bottom: 0; }
      .key-row.is-missing { background: color-mix(in srgb, var(--app-bg) 60%, var(--surface)); }
      .key-row__icon {
        width: 28px; height: 28px;
        display: inline-flex; align-items: center; justify-content: center;
        font-family: var(--ui-font); font-size: 13px; font-weight: 600;
        border: 1px solid var(--line);
        color: var(--fg);
      }
      .key-row.is-missing .key-row__icon { color: var(--fg-subtle); }
      .key-row__icon--anthropic,
      .key-row__icon--openai,
      .key-row__icon--openrouter,
      .key-row__icon--google { background: transparent; }
      .key-row__info { min-width: 0; }
      .key-row__name {
        display: flex; align-items: center; gap: 10px;
        font-family: var(--ui-font); margin-bottom: 4px; flex-wrap: wrap;
      }
      .key-row__label { font-size: 13px; font-weight: 500; color: var(--fg); }
      .key-row__tag {
        font-family: var(--ui-font); font-size: 10.5px;
        letter-spacing: .04em; font-weight: 500;
      }
      .key-row__tag.is-ok { color: var(--accent); }
      .key-row__tag.is-muted { color: var(--fg-subtle); }
      .key-row__env {
        font-family: var(--ui-font); font-size: 10.5px;
        color: var(--fg-subtle); letter-spacing: .04em;
        padding: 1px 6px; border: 1px solid var(--line);
      }
      .key-row__sub {
        font-family: var(--ui-font); font-size: 11.5px; color: var(--fg-muted);
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        min-height: 18px;
      }
      .key-row__sub code {
        font-family: var(--ui-font); background: var(--app-bg-muted);
        padding: 1px 7px; color: var(--fg-muted);
        border: 1px solid var(--line);
      }
      .key-row__sep { color: var(--fg-subtle); }
      .key-row__link { color: var(--accent); text-decoration: none; }
      .key-row__link:hover { text-decoration: underline; }
      .key-row__editor {
        display: inline-flex; gap: 6px; align-items: center;
        flex-wrap: wrap; width: 100%;
      }
      .key-row__prompt { color: var(--accent); font-weight: 600; }
      .key-row__input {
        flex: 1; min-width: 200px; height: 26px; padding: 0 8px;
        border: 1px solid var(--line-strong);
        background: var(--app-bg);
        font-family: var(--ui-font); font-size: 12px;
        color: var(--fg); outline: none;
      }
      .key-row__input:focus { border-color: var(--accent); }
      .key-row__error { font-family: var(--ui-font); font-size: 11px; color: var(--danger); margin-top: 6px; }
      .key-row__actions { display: flex; gap: 4px; align-items: center; }

      /* form grid (account settings) — sharp, bordered stack */
      .form-grid { background: var(--surface); border: 1px solid var(--line); }
      .form-row {
        display: grid; grid-template-columns: minmax(160px, 200px) 1fr auto;
        gap: 18px; padding: 14px 16px; align-items: center;
        border-bottom: 1px solid var(--line);
      }
      .form-row:last-child { border-bottom: 0; }
      .form-row__label {
        font-family: var(--ui-font); font-size: 12px; font-weight: 500;
        color: var(--fg); letter-spacing: .02em;
      }
      .form-row__hint {
        font-family: var(--ui-font); font-size: 11px;
        color: var(--fg-subtle); margin-top: 3px;
      }
      .profile-input {
        width: 100%; max-width: 320px; height: 30px; padding: 0 10px;
        border: 1px solid var(--line-strong);
        background: var(--app-bg);
        font-family: var(--ui-font); font-size: 12.5px;
        color: var(--fg); outline: none;
      }
      .profile-input:focus { border-color: var(--accent); }
      .profile-input--readonly { background: var(--app-bg-muted); color: var(--fg-muted); cursor: default; }
      .google-pill {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 4px 10px;
        border: 1px solid var(--line); background: var(--app-bg-muted);
        font-family: var(--ui-font); font-size: 12px; color: var(--fg);
        max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .google-pill__check {
        color: var(--ok); font-size: 10.5px; letter-spacing: .04em;
      }
      .theme-picker { display: flex; gap: 8px; flex-wrap: wrap; }
      .theme-swatch {
        position: relative;
        width: 56px; height: 32px;
        border: 1px solid var(--line);
        background-clip: padding-box;
        padding: 0; cursor: pointer;
        transition: border-color var(--t-quick);
      }
      .theme-swatch:hover { border-color: var(--line-strong); }
      .theme-swatch.is-active {
        border-color: var(--accent);
        box-shadow: inset 0 0 0 1px var(--accent);
      }

      /* shared bits — sharp buttons */
      .profile-btn {
        display: inline-flex; align-items: center; justify-content: center;
        gap: 6px; height: 30px; padding: 0 12px;
        border: 1px solid var(--line-strong);
        background: var(--surface); color: var(--fg);
        font-family: var(--ui-font); font-size: 12px; font-weight: 500;
        cursor: pointer; text-transform: lowercase; letter-spacing: .02em;
        transition: background var(--t-quick), border-color var(--t-quick), color var(--t-quick);
      }
      .profile-btn:hover {
        background: var(--surface-hover);
        border-color: var(--accent);
        color: var(--accent);
      }
      .profile-btn:disabled { opacity: 0.4; cursor: default; }
      .profile-btn:disabled:hover { background: var(--surface); border-color: var(--line-strong); color: var(--fg); }
      .profile-btn--sm { height: 24px; padding: 0 9px; font-size: 11px; }
      .profile-btn--ghost {
        background: transparent; border-color: transparent; color: var(--fg-muted);
      }
      .profile-btn--ghost:hover {
        background: var(--surface-hover); border-color: transparent; color: var(--fg);
      }
      .icon-btn {
        width: 26px; height: 26px;
        display: inline-flex; align-items: center; justify-content: center;
        color: var(--fg-muted); background: transparent;
        border: 1px solid transparent; cursor: pointer;
        transition: background var(--t-quick), color var(--t-quick), border-color var(--t-quick);
      }
      .icon-btn:hover { background: var(--surface-hover); color: var(--fg); border-color: var(--line); }
      .icon-btn--danger:hover { color: var(--danger); border-color: var(--danger); background: transparent; }

      /* footer — sharp, terminal-faint */
      .profile-footer {
        margin-top: 60px; padding-top: 20px; border-top: 1px solid var(--line);
        display: flex; justify-content: space-between; align-items: center;
        gap: 12px; flex-wrap: wrap;
        font-family: var(--ui-font); font-size: 11px; color: var(--fg-subtle);
      }
      .profile-footer a { color: var(--fg-muted); white-space: nowrap; text-decoration: none; }
      .profile-footer a:hover { color: var(--fg); }
      .profile-footer nav { display: flex; gap: 18px; }

      /* scrollbar polish */
      .heatmap__main::-webkit-scrollbar { height: 6px; }
      .heatmap__main::-webkit-scrollbar-thumb { background: var(--line-strong); }
    `}</style>
  );
}
