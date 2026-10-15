import React, { useEffect, useId, useState } from 'react';
import { isCrewMemoryMode, type CrewMemoryMode } from 'michi-shared';
import { toast } from 'sonner';

export const CREW_MEMORY_CHOICES: ReadonlyArray<{ mode: CrewMemoryMode; label: string; description: string }> = [
  { mode: 'persistent', label: 'Read & learn', description: 'Recall saved memory and learn reusable preferences.' },
  { mode: 'incognito', label: 'Read only', description: 'Recall saved memory without adding or changing it.' },
  { mode: 'temporary', label: 'Off', description: 'Do not read or write learned memory.' },
];

const defaultsChanged = new EventTarget();

export function useCrewMemory(apiBase: string, enabled: boolean, nodeId?: string, bound = false) {
  const [snapshot, setSnapshot] = useState<{ key: string; mode?: CrewMemoryMode; defaultMode: CrewMemoryMode } | null>(null);
  const [choice, setChoice] = useState<{ key: string; mode: CrewMemoryMode } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    const changed = () => refresh((value) => value + 1);
    defaultsChanged.addEventListener(apiBase, changed);
    return () => defaultsChanged.removeEventListener(apiBase, changed);
  }, [apiBase]);
  const key = `${apiBase}:${nodeId ?? ''}:${bound}`;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // Unsaved graph nodes do not exist on the backend yet. Resolve only the default.
    void fetch(`${apiBase}/crew/memory${bound && nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok || !isCrewMemoryMode(body.defaultMode)) throw new Error('Crew memory settings are unavailable');
        if (!controller.signal.aborted) {
          setSnapshot({ key, defaultMode: body.defaultMode, ...(isCrewMemoryMode(body.mode) ? { mode: body.mode } : {}) });
          setError(null);
        }
      }).catch((err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Crew memory settings unavailable'); });
    return () => controller.abort();
  }, [apiBase, enabled, nodeId, bound, key, revision]);
  const current = snapshot?.key === key ? snapshot : null;
  return {
    mode: bound ? current?.mode : choice?.key === key ? choice.mode : current?.defaultMode,
    // Only an explicit composer choice overrides the server-side default.
    override: !bound && choice?.key === key ? choice.mode : undefined,
    error,
    setMode: (mode: CrewMemoryMode) => setChoice({ key, mode }),
  };
}

export function CrewMemorySettings({ apiBase }: { apiBase: string }) {
  const memory = useCrewMemory(apiBase, true);
  const selectId = useId();
  const [saving, setSaving] = useState(false);
  return <div style={{ fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-lg)', color: 'var(--term-fg)', marginBottom: 18 }}>
    <label htmlFor={selectId} style={{ display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)', marginBottom: 4 }}>Memory</label>
    <select
      id={selectId}
      aria-label="Crew memory"
      value={memory.mode ?? ''}
      disabled={saving || !memory.mode}
      onChange={async (event) => {
        const mode = event.target.value;
        if (!isCrewMemoryMode(mode)) return;
        setSaving(true);
        try {
          const res = await fetch(`${apiBase}/crew/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultMode: mode }) });
          if (!res.ok) throw new Error('Failed to save Crew memory default');
          defaultsChanged.dispatchEvent(new Event(apiBase));
        } catch (err) {
          toast.error(err instanceof Error ? err.message : 'Failed to save memory setting');
        } finally {
          setSaving(false);
        }
      }}
      style={{
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-md)',
        padding: '6px 8px',
        border: '1px solid var(--term-line)',
        background: 'var(--term-surface-glass)',
        color: 'var(--term-fg)',
        width: 'min(320px, 100%)',
        minWidth: 0,
      }}
    >
      {!memory.mode && <option value="" disabled>{memory.error ? 'Unavailable' : 'Loading…'}</option>}
      {CREW_MEMORY_CHOICES.map((item) => <option key={item.mode} value={item.mode}>{item.label}</option>)}
    </select>
    {memory.error && <div role="alert" style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger)', marginTop: 6 }}>{memory.error}</div>}
  </div>;
}
