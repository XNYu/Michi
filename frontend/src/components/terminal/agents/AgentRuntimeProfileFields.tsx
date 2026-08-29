import React from 'react';
import type { RuntimeReasoning } from 'michi-shared';
import type { AgentModelInfo, AgentProviderInfo, AgentRuntimeOption } from '../../../services/api/agentRuntime';

export interface RuntimeProfileDraft {
  runtimeId: string;
  providerId: string;
  modelId: string;
  reasoning: RuntimeReasoning | '';
  modeId: string;
}

export const emptyRuntimeProfileDraft = (): RuntimeProfileDraft => ({
  runtimeId: '', providerId: '', modelId: '', reasoning: '', modeId: '',
});

/**
 * Catalog shape shared by the primary profile and every fallback profile.
 * `modelsFor` is keyed by `${runtimeId}:${providerId}` (providerId may be
 * empty for runtimes that own their model list). `requestModels` is fired
 * lazily so fallback rows do not fan out fetches until they need options.
 */
export interface RuntimeFieldCatalog {
  runtimes: AgentRuntimeOption[];
  providersFor: Record<string, AgentProviderInfo[] | undefined>;
  modelsFor: Record<string, AgentModelInfo[] | undefined>;
  request: (runtimeId: string, providerId: string) => void;
}

export const catalogKey = (runtimeId: string, providerId: string) => `${runtimeId}:${providerId}`;

interface Props {
  value: RuntimeProfileDraft;
  onChange: (value: RuntimeProfileDraft) => void;
  prefix?: string;
  errors?: Partial<Record<keyof RuntimeProfileDraft, string>>;
  compact?: boolean;
  /** When null/undefined (catalog unavailable) fields fall back to text inputs. */
  catalog?: RuntimeFieldCatalog | null;
}

const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', border: '1px solid var(--term-line)',
  background: 'var(--term-panel, var(--term-bg))', color: 'var(--term-fg)',
  fontFamily: 'var(--ui-font)', fontSize: 12, padding: '7px 9px', outline: 'none',
};

export default function AgentRuntimeProfileFields({ value, onChange, prefix = 'runtime', errors = {}, compact = false, catalog = null }: Props) {
  const set = <K extends keyof RuntimeProfileDraft>(key: K, next: RuntimeProfileDraft[K]) => onChange({ ...value, [key]: next });
  const runtimes = catalog?.runtimes ?? [];
  const providers = catalog?.providersFor[value.runtimeId];
  const models = catalog?.modelsFor[catalogKey(value.runtimeId, value.providerId)];
  React.useEffect(() => {
    if (catalog && value.runtimeId) catalog.request(value.runtimeId, value.providerId);
  }, [catalog, value.runtimeId, value.providerId]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: compact ? 'repeat(2, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
      <Field label="Runtime" error={errors.runtimeId}>
        {runtimes.length > 0 ? (
          <select aria-label={`${prefix} runtime`} value={value.runtimeId}
            onChange={(event) => onChange({ ...value, runtimeId: event.target.value, providerId: '', modelId: '' })} style={inputStyle}>
            <option value="">choose runtime…</option>
            {runtimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>{runtime.label}{runtime.available ? '' : ' (unavailable)'}</option>
            ))}
            {value.runtimeId && !runtimes.some((runtime) => runtime.id === value.runtimeId) && (
              <option value={value.runtimeId}>{value.runtimeId} (not on this backend)</option>
            )}
          </select>
        ) : (
          <input aria-label={`${prefix} runtime`} value={value.runtimeId} onChange={(event) => set('runtimeId', event.target.value)} placeholder="pi, claude, kiro, codex" style={inputStyle} />
        )}
      </Field>
      <Field label="Provider" error={errors.providerId}>
        {providers && providers.length > 0 ? (
          <select aria-label={`${prefix} provider`} value={value.providerId}
            onChange={(event) => onChange({ ...value, providerId: event.target.value, modelId: '' })} style={inputStyle}>
            <option value="">choose provider…</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.label}{provider.hasKey === false ? ' (no key)' : ''}</option>
            ))}
            {value.providerId && !providers.some((provider) => provider.id === value.providerId) && (
              <option value={value.providerId}>{value.providerId}</option>
            )}
          </select>
        ) : (
          <input aria-label={`${prefix} provider`} value={value.providerId} onChange={(event) => set('providerId', event.target.value)} placeholder={catalog && value.runtimeId ? 'runtime-managed' : 'optional'} style={inputStyle} />
        )}
      </Field>
      <Field label="Model" error={errors.modelId}>
        {models && models.length > 0 ? (
          <select aria-label={`${prefix} model`} value={value.modelId} onChange={(event) => set('modelId', event.target.value)} style={inputStyle}>
            <option value="">runtime default</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.label ?? model.id}</option>
            ))}
            {value.modelId && !models.some((model) => model.id === value.modelId) && (
              <option value={value.modelId}>{value.modelId}</option>
            )}
          </select>
        ) : (
          <input aria-label={`${prefix} model`} value={value.modelId} onChange={(event) => set('modelId', event.target.value)} placeholder="optional model ID" style={inputStyle} />
        )}
      </Field>
      <Field label="Reasoning" error={errors.reasoning}>
        <select aria-label={`${prefix} reasoning`} value={value.reasoning} onChange={(event) => set('reasoning', event.target.value as RuntimeProfileDraft['reasoning'])} style={inputStyle}>
          <option value="">runtime default</option>
          {['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((reasoning) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}
        </select>
      </Field>
      <Field label="Mode" error={errors.modeId}>
        <input aria-label={`${prefix} mode`} value={value.modeId} onChange={(event) => set('modeId', event.target.value)} placeholder="optional mode" style={inputStyle} />
      </Field>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase' }}>
      {label}
      {children}
      {error && <span role="alert" style={{ color: 'var(--danger, var(--term-error))', fontSize: 10, letterSpacing: 0, textTransform: 'none' }}>{error}</span>}
    </label>
  );
}

export { inputStyle as agentFieldStyle };
