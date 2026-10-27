import React, { useEffect, useId, useRef, useState } from 'react';
import {
  MICHI_ASSISTANT_RESET_EVENT,
  isAssistantMissing,
  resetAssistant,
  updateAssistantSettings,
  type AssistantInfo,
  type AssistantSettingsPatch,
} from '../../../../../services/api/assistant';
import { fetchAgentStatus, type AgentReasoning, type AgentStatus } from '../../../../../services/api/agentRuntime';
import type { ResolvedNodeBinding } from '../../../../../state/nodeBindingResolution';
import { useRuntimeCatalog } from '../../../../../hooks/useRuntimeCatalog';
import { useBackendScope } from '../../../../../hooks/useBackendScope';
import { resolveComposerReasoning } from '../../../composerReasoning';
import { composerModelLabel } from '../../../composerModelLabel';
import { REASONING_LABELS } from '../../../PaneComposerToolbarLeft';
import { MichiSectionLabel } from '../../../content/MichiSectionLabel';
import { confirmDialog } from '../../../../ui/ConfirmDialog';
import { Switch } from '../../../../ui/controls';
import { probeAssistant, rememberAssistant } from './assistantProbe';
import './assistantSettings.css';

type Load =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed' }
  | { kind: 'ready'; info: AssistantInfo };

/**
 * The ⌘J assistant's runtime, model and reasoning, and starting it over.
 * Hidden entirely when this backend has no assistant (404, or an answer
 * that is not one).
 */
export function MichiAssistantSettings() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    probeAssistant().then(
      (info) => { if (live) setLoad({ kind: 'ready', info }); },
      (err) => { if (live) setLoad(isAssistantMissing(err) ? { kind: 'missing' } : { kind: 'failed' }); },
    );
    return () => { live = false; };
  }, []);

  // Nothing until the first answer, so a backend without an assistant never flashes the box.
  if (load.kind === 'loading' || load.kind === 'missing') return null;

  return (
    <section className="michi-set" aria-label="Assistant">
      <div className="michi-set__head"><MichiSectionLabel label="Assistant" /></div>
      {load.kind === 'failed'
        ? <div className="michi-set__status is-error" role="alert">Couldn&apos;t load the assistant</div>
        : <AssistantForm info={load.info} onInfo={(info) => { rememberAssistant(info); setLoad({ kind: 'ready', info }); }} />}
    </section>
  );
}

function AssistantForm({ info, onInfo }: { info: AssistantInfo; onInfo: (info: AssistantInfo) => void }) {
  const scope = useBackendScope('local');
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setAgentStatus(null);
    fetchAgentStatus('local', controller.signal).then(
      (status) => { if (live) setAgentStatus(status); },
      () => { if (live) setAgentStatus(null); },
    );
    return () => { live = false; controller.abort(); };
  }, [scope.key]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reasoningId = useId();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const { runtimeId, modelId, reasoning } = info.settings;
  const catalog = useRuntimeCatalog({ enabled: true, connectionId: 'local', runtime: runtimeId });
  const binding: ResolvedNodeBinding = {
    runtime: runtimeId,
    provider: undefined,
    model: modelId ?? undefined,
    reasoning: reasoning ?? undefined,
    source: 'global',
  };
  const effortFor = (model: ResolvedNodeBinding['model']) => resolveComposerReasoning(
    { ...binding, model }, agentStatus, catalog.capabilities, catalog.models, catalog.providers);
  const effort = effortFor(binding.model);
  // An explicit level is shown pressed only while this model offers it; otherwise Default is.
  const pickedLevel = reasoning !== null && effort.levels.includes(reasoning) ? reasoning : null;
  const runtimes = agentStatus?.availableRuntimes ?? [];
  const runtimeLabel = (id: string) => runtimes.find((r) => r.id === id)?.label || id;
  const runtimeAvailable = (id: string) => runtimes.find((r) => r.id === id)?.available !== false;
  const modelMissing = !!modelId && !catalog.models.some((m) => m.id === modelId);

  const run = async (call: () => Promise<AssistantInfo>, failure: string): Promise<AssistantInfo | null> => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const next = await call();
      if (mountedRef.current) onInfo(next);
      return next;
    } catch {
      if (mountedRef.current) setError(failure);
      return null;
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };
  const save = (patch: AssistantSettingsPatch) => run(() => updateAssistantSettings(patch), "Couldn't save the assistant's settings");

  // A reasoning level the new model does not offer goes back to the model's default.
  const saveModel = (next: string | null) => {
    const levels = effortFor(next ?? undefined);
    const drop = reasoning !== null && levels.known && catalog.models.length > 0 && !levels.levels.includes(reasoning);
    void save(drop ? { modelId: next, reasoning: null } : { modelId: next });
  };

  const startOver = async () => {
    const ok = await confirmDialog({
      title: 'Start a new conversation',
      message: 'The assistant starts over in a new conversation.',
      confirmLabel: 'Start new',
      danger: false,
    });
    if (!ok) return;
    const next = await run(resetAssistant, "Couldn't start a new conversation");
    if (!next) return;
    // The ⌘J panel switches to the new conversation.
    window.dispatchEvent(new CustomEvent<AssistantInfo>(MICHI_ASSISTANT_RESET_EVENT, { detail: next }));
    if (mountedRef.current) setNotice('Started a new conversation');
  };

  return (
    <>
      <div className="michi-set__row">
        <div>
          <div className="michi-set__t">Runtime</div>
          <div className="michi-set__d">Applies to new conversations; the current one keeps its settings</div>
        </div>
        <select
          className="michi-set__select"
          aria-label="Assistant runtime"
          value={runtimeId}
          disabled={saving}
          // A model belongs to one runtime: switching starts from the new runtime's defaults.
          onChange={(e) => { void save({ runtimeId: e.target.value, modelId: null, reasoning: null }); }}
        >
          {!info.supportedRuntimes.includes(runtimeId) && <option value={runtimeId}>{runtimeLabel(runtimeId)}</option>}
          {info.supportedRuntimes.map((id) => (
            <option key={id} value={id} disabled={id !== runtimeId && !runtimeAvailable(id)}>
              {runtimeLabel(id)}{runtimeAvailable(id) ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
      </div>

      <div className="michi-set__row">
        <div>
          <div className="michi-set__t">Model</div>
          <div className="michi-set__d">
            {catalog.loading
              ? 'Reading models…'
              : (
                <>
                  {catalog.error && <span className="michi-src__problem">{catalog.error} · </span>}
                  <button type="button" className="michi-set__link" onClick={catalog.retry}>Re-check</button>
                </>
              )}
          </div>
        </div>
        <select
          className="michi-set__select"
          aria-label="Assistant model"
          value={modelId ?? ''}
          disabled={saving}
          onChange={(e) => saveModel(e.target.value || null)}
        >
          <option value="">Default</option>
          {modelMissing && <option value={modelId!}>{composerModelLabel(runtimeId, modelId!, catalog.models)}</option>}
          {catalog.models.map((m) => (
            <option key={m.id} value={m.id}>{m.label || m.id}</option>
          ))}
        </select>
      </div>

      {effort.adjustable && (
        <div className="michi-set__row michi-set__row--wrap">
          <div className="michi-set__t" id={reasoningId}>Reasoning</div>
          <div className="michi-set__seg" role="group" aria-labelledby={reasoningId}>
            <button
              type="button"
              aria-pressed={pickedLevel === null}
              disabled={saving}
              onClick={() => { if (reasoning !== null) void save({ reasoning: null }); }}
            >
              Default
            </button>
            {effort.levels.map((level: AgentReasoning) => (
              <button
                key={level}
                type="button"
                aria-pressed={level === pickedLevel}
                disabled={saving}
                onClick={() => { if (level !== reasoning) void save({ reasoning: level }); }}
              >
                {REASONING_LABELS[level] ?? level}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="michi-set__row">
        <div className="michi-set__t">Start a new conversation</div>
        <button type="button" className="michi-set__btn" disabled={saving} onClick={() => { void startOver(); }}>
          Start new
        </button>
      </div>

      <div className="michi-set__row" aria-disabled="true">
        <div>
          <div className="michi-set__t">Sandboxed widgets</div>
          <div className="michi-set__d">Coming later</div>
        </div>
        <Switch on={false} disabled onChange={() => {}} aria-label="Sandboxed widgets" />
      </div>

      {error && <div className="michi-set__status is-error" role="alert">{error}</div>}
      {notice && <div className="michi-set__status" role="status">{notice}</div>}
    </>
  );
}
