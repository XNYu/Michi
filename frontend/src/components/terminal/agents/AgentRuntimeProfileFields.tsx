import React from 'react';
import { changeRuntimeProfile, resolveProfileReasoning, supportedProfileReasoning } from '../../../lib/runtimeProfile';
import { filterAvailableRuntimes } from '../../../lib/runtimeVisibility';
import type { RuntimeReasoning } from 'michi-shared';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentRuntimeOption } from '../../../services/api/agentRuntime';

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
 * `modelsFor` is keyed by `catalogKey(runtimeId, providerId)` (providerId may be
 * empty for runtimes that own their model list). `requestModels` is fired
 * lazily so fallback rows do not fan out fetches until they need options.
 */
export interface RuntimeFieldCatalog {
  runtimes: AgentRuntimeOption[];
  providersFor: Record<string, AgentProviderInfo[] | undefined>;
  modelsFor: Record<string, AgentModelInfo[] | undefined>;
  errorsFor?: Record<string, string | undefined>;
  retry?: (runtimeId: string, providerId: string) => void;
  capabilitiesFor?: Record<string, AgentCapabilities | undefined>;
  request: (runtimeId: string, providerId: string) => void;
}

export const catalogKey = (runtimeId: string, providerId: string) => JSON.stringify([runtimeId, providerId]);

interface Props {
  value: RuntimeProfileDraft;
  onChange: (value: RuntimeProfileDraft) => void;
  prefix?: string;
  errors?: Partial<Record<keyof RuntimeProfileDraft, string>>;
  compact?: boolean;
  /** When null/undefined (catalog unavailable) fields fall back to text inputs. */
  catalog?: RuntimeFieldCatalog | null;
}

export default function AgentRuntimeProfileFields({ value, onChange, prefix = 'runtime', errors = {}, compact = false, catalog = null }: Props) {
  const set = <K extends keyof RuntimeProfileDraft>(key: K, next: RuntimeProfileDraft[K]) => onChange({ ...value, [key]: next });
  const runtimes = filterAvailableRuntimes(catalog?.runtimes ?? []);
  const providers = catalog?.providersFor[value.runtimeId];
  const models = catalog?.modelsFor[catalogKey(value.runtimeId, value.providerId)];
  const { levels: reasoningLevels } = resolveProfileReasoning(catalog?.capabilitiesFor?.[value.runtimeId], models, value.modelId, providers?.find((provider) => provider.id === value.providerId));
  React.useEffect(() => {
    if (catalog && value.runtimeId) catalog.request(value.runtimeId, value.providerId);
  }, [catalog, value.runtimeId, value.providerId]);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: compact ? 'repeat(2, minmax(0, 1fr))' : 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
      {catalog?.errorsFor?.[catalogKey(value.runtimeId, value.providerId)] && <p role="alert">Unable to load runtime options. <button type="button" onClick={() => catalog.retry?.(value.runtimeId, value.providerId)}>Retry</button></p>}
      <Field label="Runtime" error={errors.runtimeId}>
        {catalog ? (
          <select className="ui-select" aria-label={`${prefix} runtime`} value={value.runtimeId}
            onChange={(event) => onChange(changeRuntimeProfile(value, 'runtimeId', event.target.value))}>
            <option value="">choose runtime…</option>
            {runtimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>{runtime.label}</option>
            ))}
            {value.runtimeId && !runtimes.some((runtime) => runtime.id === value.runtimeId) && (
              <option value={value.runtimeId} disabled hidden>{value.runtimeId}</option>
            )}
          </select>
        ) : (
          <input className="ui-input" aria-label={`${prefix} runtime`} value={value.runtimeId} onChange={(event) => onChange(changeRuntimeProfile(value, 'runtimeId', event.target.value))} placeholder="pi, claude, kiro, codex" />
        )}
      </Field>
      <Field label="Provider" error={errors.providerId}>
        {providers && providers.length > 0 ? (
          <select className="ui-select" aria-label={`${prefix} provider`} value={value.providerId}
            onChange={(event) => onChange(changeRuntimeProfile(value, 'providerId', event.target.value))}>
            <option value="">choose provider…</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.label}{provider.hasKey === false ? ' (no key)' : ''}</option>
            ))}
            {value.providerId && !providers.some((provider) => provider.id === value.providerId) && (
              <option value={value.providerId}>{value.providerId}</option>
            )}
          </select>
        ) : (
          <input className="ui-input" aria-label={`${prefix} provider`} value={value.providerId} onChange={(event) => onChange(changeRuntimeProfile(value, 'providerId', event.target.value))} placeholder={catalog && value.runtimeId ? 'runtime-managed' : 'optional'} />
        )}
      </Field>
      <Field label="Model" error={errors.modelId}>
        {models && models.length > 0 ? (
          <select className="ui-select" aria-label={`${prefix} model`} value={value.modelId} onChange={(event) => onChange(changeRuntimeProfile(value, 'modelId', event.target.value))}>
            <option value="">runtime default</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.label ?? model.id}</option>
            ))}
            {value.modelId && !models.some((model) => model.id === value.modelId) && (
              <option value={value.modelId}>{value.modelId}</option>
            )}
          </select>
        ) : (
          <input className="ui-input" aria-label={`${prefix} model`} value={value.modelId} onChange={(event) => onChange(changeRuntimeProfile(value, 'modelId', event.target.value))} placeholder="optional model ID" />
        )}
      </Field>
      <Field label="Reasoning" error={errors.reasoning}>
        <select className="ui-select" aria-label={`${prefix} reasoning`} value={value.reasoning} onChange={(event) => set('reasoning', event.target.value as RuntimeProfileDraft['reasoning'])}>
          <option value="">runtime default</option>
          {value.reasoning && !supportedProfileReasoning(value.reasoning, reasoningLevels) && <option value={value.reasoning} disabled>{value.reasoning} (unavailable)</option>}
          {reasoningLevels.map((reasoning) => <option key={reasoning} value={reasoning}>{reasoning}</option>)}
        </select>
        {value.reasoning && !supportedProfileReasoning(value.reasoning, reasoningLevels) && <span role="alert">This reasoning level is unavailable for the selected model. Choose runtime default or a supported level.</span>}
      </Field>
      <Field label="Mode" error={errors.modeId}>
        <input className="ui-input" aria-label={`${prefix} mode`} value={value.modeId} onChange={(event) => set('modeId', event.target.value)} placeholder="optional mode" />
      </Field>
    </div>
  );
}

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)', letterSpacing: 'var(--ls-caps)', textTransform: 'uppercase' }}>
      {label}
      {children}
      {error && <span role="alert" style={{ color: 'var(--danger, var(--term-danger))', fontSize: 'var(--fs-xs)', letterSpacing: 0, textTransform: 'none' }}>{error}</span>}
    </label>
  );
}
