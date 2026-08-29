import React from 'react';
import type { AgentCapabilityCatalogEntryV1, AgentDefinitionDtoV1 } from 'michi-shared';
import { MAX_RUN_TTL_MS, MIN_RUN_TTL_MS } from 'michi-shared';
import AgentPermissionFields, { defaultPermissionPolicyDraft, type PermissionPolicyDraft } from './AgentPermissionFields';
import AgentRuntimeProfileFields, { agentFieldStyle, emptyRuntimeProfileDraft, type RuntimeFieldCatalog, type RuntimeProfileDraft } from './AgentRuntimeProfileFields';

export interface AgentDefinitionFormValue {
  scope: 'global' | 'workspace';
  workspaceId: string | null;
  name: string;
  description: string;
  instructions: string;
  runtimeProfile: RuntimeProfileDraft;
  fallbackChain: RuntimeProfileDraft[];
  toolRefs: string;
  skillRefs: string;
  mcpServerRefs: string;
  includeWorkspaceInstructions: boolean;
  allowMessageContext: boolean;
  allowFileContext: boolean;
  allowArtifactContext: boolean;
  maxContextChars: string;
  permissionPolicy: PermissionPolicyDraft;
  retention: 'indefinite' | 'bounded';
  defaultRunTtlMs: string;
}

export type AgentDefinitionFormErrors = Record<string, string>;

export function createAgentDefinitionFormValue(definition?: AgentDefinitionDtoV1 | null, scope: 'global' | 'workspace' = 'workspace', workspaceId: string | null = null): AgentDefinitionFormValue {
  if (!definition) return {
    scope, workspaceId: scope === 'workspace' ? workspaceId : null, name: '', description: '', instructions: '',
    runtimeProfile: emptyRuntimeProfileDraft(), fallbackChain: [], toolRefs: '', skillRefs: '', mcpServerRefs: '',
    includeWorkspaceInstructions: true, allowMessageContext: true, allowFileContext: true, allowArtifactContext: true,
    maxContextChars: '100000', permissionPolicy: defaultPermissionPolicyDraft(), retention: 'indefinite', defaultRunTtlMs: '',
  };
  const profile = (value: AgentDefinitionDtoV1['runtimeProfile']): RuntimeProfileDraft => ({ runtimeId: value.runtimeId, providerId: value.providerId ?? '', modelId: value.modelId ?? '', reasoning: value.reasoning ?? '', modeId: value.modeId ?? '' });
  const policy = definition.permissionPolicy;
  return {
    scope: definition.scope, workspaceId: definition.workspaceId, name: definition.name, description: definition.description,
    instructions: definition.instructions, runtimeProfile: profile(definition.runtimeProfile), fallbackChain: definition.fallbackChain.map(profile),
    toolRefs: definition.toolRefs.join('\n'), skillRefs: definition.skillRefs.join('\n'), mcpServerRefs: definition.mcpServerRefs.join('\n'),
    includeWorkspaceInstructions: definition.contextPolicy.includeWorkspaceInstructions,
    allowMessageContext: definition.contextPolicy.allowMessageContext, allowFileContext: definition.contextPolicy.allowFileContext,
    allowArtifactContext: definition.contextPolicy.allowArtifactContext, maxContextChars: String(definition.contextPolicy.maxEstimatedChars),
    permissionPolicy: policy ? { preset: policy.preset, categories: policy.categories, maxDelegationDepth: String(policy.maxDelegationDepth), maxConcurrentRuns: String(policy.maxConcurrentRuns), maxWallTimeMinutes: String(policy.maxWallTimeMs / 60_000), maxAttempts: String(policy.maxAttempts) } : defaultPermissionPolicyDraft(),
    retention: definition.defaultRunTtlMs === null ? 'indefinite' : 'bounded', defaultRunTtlMs: definition.defaultRunTtlMs === null ? '' : String(definition.defaultRunTtlMs),
  };
}

function positiveInteger(value: string, min: number, max: number): boolean {
  const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
}

export function validateAgentDefinitionForm(value: AgentDefinitionFormValue): AgentDefinitionFormErrors {
  const errors: AgentDefinitionFormErrors = {};
  if (!value.name.trim()) errors.name = 'Name is required.';
  if (!value.description.trim()) errors.description = 'Describe what this Agent does and when to use it.';
  // Instructions are intentionally optional: the parent supplies the task
  // (and any method hints) each run.
  if (value.scope === 'workspace' && !value.workspaceId) errors.workspaceId = 'Choose a workspace.';
  if (!value.runtimeProfile.runtimeId.trim()) errors.runtimeProfile = 'Primary runtime is required.';
  const primaryFingerprint = [value.runtimeProfile.runtimeId, value.runtimeProfile.providerId, value.runtimeProfile.modelId, value.runtimeProfile.reasoning, value.runtimeProfile.modeId].join('\0');
  const seen = new Set<string>();
  value.fallbackChain.forEach((profile, index) => {
    const key = [profile.runtimeId, profile.providerId, profile.modelId, profile.reasoning, profile.modeId].join('\0');
    if (!profile.runtimeId.trim()) errors[`fallback.${index}`] = 'Fallback runtime is required.';
    else if (key === primaryFingerprint) errors[`fallback.${index}`] = 'Fallback must differ from the primary profile.';
    else if (seen.has(key)) errors[`fallback.${index}`] = 'Duplicate fallback profile.';
    seen.add(key);
  });
  if (!positiveInteger(value.maxContextChars, 1, 1_000_000)) errors.maxContextChars = 'Context limit must be 1–1,000,000 characters.';
  if (!positiveInteger(value.permissionPolicy.maxDelegationDepth, 0, 16)) errors.maxDelegationDepth = 'Use 0–16.';
  if (!positiveInteger(value.permissionPolicy.maxConcurrentRuns, 1, 64)) errors.maxConcurrentRuns = 'Use 1–64.';
  if (!positiveInteger(value.permissionPolicy.maxWallTimeMinutes, 1, 10_080)) errors.maxWallTimeMinutes = 'Use 1–10,080 minutes.';
  if (!positiveInteger(value.permissionPolicy.maxAttempts, 1, 16)) errors.maxAttempts = 'Use 1–16.';
  if (value.retention === 'bounded' && !positiveInteger(value.defaultRunTtlMs, MIN_RUN_TTL_MS, MAX_RUN_TTL_MS)) errors.defaultRunTtlMs = `TTL must be ${MIN_RUN_TTL_MS}–${MAX_RUN_TTL_MS} ms.`;
  return errors;
}

export function draftSaveBlocked(errors: AgentDefinitionFormErrors): boolean {
  return Boolean(errors.defaultRunTtlMs || errors.workspaceId);
}

interface Props {
  value: AgentDefinitionFormValue;
  onChange: (value: AgentDefinitionFormValue) => void;
  errors?: AgentDefinitionFormErrors;
  /**
   * Browse-time capability catalog with readiness. When present the ref
   * fields become chip pickers; when null/undefined (catalog unavailable)
   * the manual newline-separated ref fields remain as a fallback.
   */
  capabilities?: AgentCapabilityCatalogEntryV1[] | null;
  /** Runtime/provider/model dropdown options; null falls back to text inputs. */
  runtimeCatalog?: RuntimeFieldCatalog | null;
}

export default function AgentDefinitionForm({ value, onChange, errors = validateAgentDefinitionForm(value), capabilities = null, runtimeCatalog = null }: Props) {
  const set = <K extends keyof AgentDefinitionFormValue>(key: K, next: AgentDefinitionFormValue[K]) => onChange({ ...value, [key]: next });
  return (
    <form aria-label="Agent definition" onSubmit={(event) => event.preventDefault()} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Identity fields carry their own labels — no section caption needed. */}
      <Section plain>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10 }}>
          <label style={labelStyle}>Scope<select aria-label="agent scope" value={value.scope} onChange={(event) => { const scope = event.target.value as AgentDefinitionFormValue['scope']; onChange({ ...value, scope, workspaceId: scope === 'global' ? null : value.workspaceId }); }} style={agentFieldStyle}><option value="workspace">Workspace</option><option value="global">Global</option></select></label>
          <Field label="Name" error={errors.name}><input aria-label="agent name" value={value.name} onChange={(event) => set('name', event.target.value)} style={agentFieldStyle} /></Field>
        </div>
        <Field label="Description · what it does, when to call it" error={errors.description}><textarea aria-label="agent description" value={value.description} onChange={(event) => set('description', event.target.value)} rows={3} style={{ ...agentFieldStyle, resize: 'vertical' }} /></Field>
        <p style={hintStyle}>Other agents read the description to decide whether to delegate here.</p>
      </Section>

      <Section plain>
        <AgentRuntimeProfileFields value={value.runtimeProfile} onChange={(next) => set('runtimeProfile', next)} errors={errors.runtimeProfile ? { runtimeId: errors.runtimeProfile } : {}} catalog={runtimeCatalog} />
      </Section>

      <Section title="Instructions" aside="optional" description="Method and standards, not the task. “Implement with TDD.” “Prefer primary sources over summaries.” The parent supplies the task each run; empty is fine.">
        <Field label="System instructions"><textarea aria-label="agent instructions" value={value.instructions} onChange={(event) => set('instructions', event.target.value)} rows={6} placeholder="Optional — leave empty to let the delegated task stand alone." style={{ ...agentFieldStyle, fontFamily: 'var(--mono-font)', resize: 'vertical' }} /></Field>
      </Section>

      <Section title="Tools, Skills & MCP" description="This list is the whole surface the agent can touch — the parent’s capabilities are not inherited. Credentials remain in Backend bindings.">
        {capabilities ? (
          <CapabilityPicker value={value} capabilities={capabilities} onChange={onChange} />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
            <RefField label="Tool refs" value={value.toolRefs} onChange={(next) => set('toolRefs', next)} />
            <RefField label="Skill refs" value={value.skillRefs} onChange={(next) => set('skillRefs', next)} />
            <RefField label="MCP server refs" value={value.mcpServerRefs} onChange={(next) => set('mcpServerRefs', next)} />
          </div>
        )}
      </Section>

      <Section title="Context" description="Runs receive only explicit context plus the selected workspace baseline.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          <Check label="Workspace instructions" checked={value.includeWorkspaceInstructions} onChange={(next) => set('includeWorkspaceInstructions', next)} />
          <Check label="Messages" checked={value.allowMessageContext} onChange={(next) => set('allowMessageContext', next)} />
          <Check label="Files" checked={value.allowFileContext} onChange={(next) => set('allowFileContext', next)} />
          <Check label="Artifacts" checked={value.allowArtifactContext} onChange={(next) => set('allowArtifactContext', next)} />
        </div>
        <Field label="Maximum estimated characters" error={errors.maxContextChars}><input aria-label="maximum context characters" value={value.maxContextChars} onChange={(event) => set('maxContextChars', event.target.value)} inputMode="numeric" style={{ ...agentFieldStyle, maxWidth: 240 }} /></Field>
      </Section>

      <Section title="Permissions" description="A Definition is a ceiling. Parent restrictions can only reduce it.">
        <AgentPermissionFields value={value.permissionPolicy} onChange={(next) => set('permissionPolicy', next)} errors={errors} />
      </Section>

      <Section title="Fallback" description="Ordered profiles tried only after a classified failure.">
        {value.fallbackChain.map((profile, index) => <div key={index} style={{ border: '1px solid var(--term-line)', padding: 12 }}><AgentRuntimeProfileFields prefix={`fallback ${index + 1}`} compact value={profile} onChange={(next) => set('fallbackChain', value.fallbackChain.map((item, itemIndex) => itemIndex === index ? next : item))} errors={errors[`fallback.${index}`] ? { runtimeId: errors[`fallback.${index}`] } : {}} catalog={runtimeCatalog} /><button type="button" onClick={() => set('fallbackChain', value.fallbackChain.filter((_, itemIndex) => itemIndex !== index))} style={textButtonStyle}>remove fallback</button></div>)}
        <button type="button" onClick={() => set('fallbackChain', [...value.fallbackChain, emptyRuntimeProfileDraft()])} style={outlineButtonStyle}>+ add fallback profile</button>
      </Section>

      <Section title="Advanced" description="Retention is indefinite unless a bounded default is explicitly selected.">
        <div role="radiogroup" aria-label="run retention" style={{ display: 'flex', gap: 16 }}>
          <Check type="radio" name="retention" label="Indefinite" checked={value.retention === 'indefinite'} onChange={() => onChange({ ...value, retention: 'indefinite', defaultRunTtlMs: '' })} />
          <Check type="radio" name="retention" label="Bounded default" checked={value.retention === 'bounded'} onChange={() => set('retention', 'bounded')} />
        </div>
        {value.retention === 'bounded' && <Field label="Default Run TTL (milliseconds)" error={errors.defaultRunTtlMs}><input aria-label="default run TTL milliseconds" value={value.defaultRunTtlMs} onChange={(event) => set('defaultRunTtlMs', event.target.value)} inputMode="numeric" style={{ ...agentFieldStyle, maxWidth: 280 }} /></Field>}
      </Section>
    </form>
  );
}

function Section({ title, aside, description, plain = false, children }: { title?: string; aside?: string; description?: string; plain?: boolean; children: React.ReactNode }) {
  // No divider rules between sections — grouping is spacing + quiet captions
  // (mock feedback: field rows already carry their own labels).
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {!plain && title && (
        <div>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'baseline', gap: 8, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', fontSize: 15, fontWeight: 600 }}>
            {title}
            {aside && <span style={{ color: 'var(--term-faint)', fontSize: 10, fontWeight: 400 }}>{aside}</span>}
          </h2>
          {description && <p style={{ margin: '4px 0 0', color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 11 }}>{description}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

type CapabilityKind = AgentCapabilityCatalogEntryV1['kind'];
const KIND_TO_FIELD: Record<CapabilityKind, 'toolRefs' | 'skillRefs' | 'mcpServerRefs'> = {
  tool: 'toolRefs', skill: 'skillRefs', mcp_server: 'mcpServerRefs',
};
const KIND_LABEL: Record<CapabilityKind, string> = { tool: 'tool', skill: 'skill', mcp_server: 'mcp' };

function splitRefs(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

/**
 * Chip-based capability selection backed by the readiness catalog. Selected
 * refs that are missing from the catalog (or not ready) render as warning
 * chips — the same blockers enable will report — and stay removable.
 */
function CapabilityPicker({ value, capabilities, onChange }: { value: AgentDefinitionFormValue; capabilities: AgentCapabilityCatalogEntryV1[]; onChange: (value: AgentDefinitionFormValue) => void }) {
  const byKey = new Map(capabilities.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
  const selected: Array<{ kind: CapabilityKind; id: string }> = [
    ...splitRefs(value.toolRefs).map((id) => ({ kind: 'tool' as const, id })),
    ...splitRefs(value.skillRefs).map((id) => ({ kind: 'skill' as const, id })),
    ...splitRefs(value.mcpServerRefs).map((id) => ({ kind: 'mcp_server' as const, id })),
  ];
  const selectedKeys = new Set(selected.map((ref) => `${ref.kind}:${ref.id}`));
  const available = capabilities.filter((entry) => !selectedKeys.has(`${entry.kind}:${entry.id}`));
  const mutate = (kind: CapabilityKind, next: string[]) => onChange({ ...value, [KIND_TO_FIELD[kind]]: next.join('\n') });
  const remove = (ref: { kind: CapabilityKind; id: string }) =>
    mutate(ref.kind, splitRefs(value[KIND_TO_FIELD[ref.kind]]).filter((id) => id !== ref.id));
  const add = (key: string) => {
    if (!key) return;
    const entry = byKey.get(key);
    if (!entry) return;
    mutate(entry.kind, [...splitRefs(value[KIND_TO_FIELD[entry.kind]]), entry.id]);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {selected.map((ref) => {
          const key = `${ref.kind}:${ref.id}`;
          const entry = byKey.get(key);
          const unresolved = !entry || entry.readiness !== 'ready';
          const title = !entry ? 'not found on this backend' : entry.readiness !== 'ready' ? entry.readiness.replace('_', ' ') : undefined;
          return (
            <span key={key} data-testid={unresolved ? 'capability-chip-unresolved' : 'capability-chip'} title={title} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, padding: '3px 8px',
              border: `1px solid ${unresolved ? 'var(--term-select)' : ref.kind === 'skill' ? 'var(--term-mauve)' : 'var(--term-line)'}`,
              background: unresolved ? 'var(--term-select-f)' : ref.kind === 'skill' ? 'var(--term-mauve-f)' : 'var(--term-surface)',
              color: unresolved ? 'var(--term-fg)' : ref.kind === 'skill' ? 'var(--term-mauve)' : 'var(--term-fg)',
              fontFamily: unresolved ? 'var(--mono-font)' : 'var(--ui-font)',
            }}>
              {unresolved ? '⚠' : <span aria-hidden style={{ width: 4, height: 4, background: ref.kind === 'skill' ? 'var(--term-mauve)' : 'var(--term-digest)' }} />}
              {ref.kind === 'tool' ? ref.id : `${KIND_LABEL[ref.kind]}: ${ref.id}`}
              <button type="button" aria-label={`Remove capability ${ref.id}`} onClick={() => remove(ref)}
                style={{ border: 0, padding: 0, background: 'transparent', color: 'var(--term-faint)', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>×</button>
            </span>
          );
        })}
        <select aria-label="add capability" value="" onChange={(event) => add(event.target.value)}
          style={{ ...agentFieldStyle, width: 'auto', fontSize: 11, borderStyle: 'dashed', color: 'var(--term-muted)' }}>
          <option value="">+ browse capabilities</option>
          {available.map((entry) => (
            <option key={`${entry.kind}:${entry.id}`} value={`${entry.kind}:${entry.id}`}>
              {KIND_LABEL[entry.kind]} · {entry.id}{entry.readiness !== 'ready' ? ` (${entry.readiness.replace('_', ' ')})` : ''}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

const hintStyle: React.CSSProperties = { margin: 0, color: 'var(--term-faint)', fontFamily: 'var(--ui-font)', fontSize: 10.5 };
function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) { return <label style={labelStyle}>{label}{children}{error && <span role="alert" style={{ color: 'var(--danger, var(--term-error))', fontSize: 10, letterSpacing: 0, textTransform: 'none' }}>{error}</span>}</label>; }
function RefField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <Field label={label}><textarea aria-label={label.toLowerCase()} value={value} onChange={(event) => onChange(event.target.value)} rows={4} style={{ ...agentFieldStyle, fontFamily: 'var(--mono-font)', resize: 'vertical' }} /></Field>; }
function Check({ label, checked, onChange, type = 'checkbox', name }: { label: string; checked: boolean; onChange: (value: boolean) => void; type?: 'checkbox' | 'radio'; name?: string }) { return <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: 'var(--term-fg)', fontFamily: 'var(--ui-font)', fontSize: 12 }}><input type={type} name={name} checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>; }
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5, color: 'var(--term-muted)', fontFamily: 'var(--ui-font)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase' };
export const outlineButtonStyle: React.CSSProperties = { alignSelf: 'flex-start', border: '1px solid var(--term-line)', background: 'transparent', color: 'var(--term-fg)', padding: '6px 10px', fontFamily: 'var(--ui-font)', fontSize: 11, cursor: 'pointer' };
const textButtonStyle: React.CSSProperties = { ...outlineButtonStyle, border: 0, padding: '7px 0 0', color: 'var(--term-muted)' };
