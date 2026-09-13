import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentCapabilities, AgentModelInfo, AgentProviderInfo, AgentReasoning, AgentStatus } from '../../services/api';
import type { ResolvedNodeBinding } from '../../state/nodeBindingResolution';
import { PopoverSurface } from '../ui/Popover';
import { useMenuConfirm } from '../ui/useMenuConfirm';
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, RetryIcon } from './icons';
import { REASONING_LABELS, type PaneMenuAnchor } from './PaneComposerToolbarLeft';
import './ComposerModelPicker.css';
import { resolveComposerReasoning } from './composerReasoning';

type PickerPage = 'overview' | 'model' | 'runtime' | 'provider';
type SelectionHandler<T> = (value: T) => void | Promise<void>;

export interface ComposerModelPickerProps {
  anchor: PaneMenuAnchor;
  agentStatus: AgentStatus | null;
  resolvedBinding: ResolvedNodeBinding;
  catalogCapabilities: AgentCapabilities | null;
  providerModels: readonly AgentModelInfo[];
  providers?: readonly AgentProviderInfo[];
  modelsLoading: boolean;
  modelsWaiting?: boolean;
  modelsError: string | null;
  onSwitchRuntime: SelectionHandler<string>;
  onSaveProvider?: SelectionHandler<string>;
  onSaveModel: SelectionHandler<string>;
  onSaveReasoning: SelectionHandler<AgentReasoning>;
  onRetryModels: () => void;
  onClose: () => void;
}

const focusableSelector = 'button:not(:disabled), input:not(:disabled)';

export function ComposerModelPicker({
  anchor, agentStatus, resolvedBinding, catalogCapabilities, providerModels, providers = [],
  modelsLoading, modelsWaiting = false, modelsError, onSwitchRuntime, onSaveProvider,
  onSaveModel, onSaveReasoning, onRetryModels, onClose,
}: ComposerModelPickerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<PickerPage>('overview');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { blinkingId, confirm, cancel } = useMenuConfirm();
  const busyRef = useRef(false);
  const savingFocusRef = useRef<HTMLElement | null>(null);
  const mountedRef = useRef(true);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y, maxHeight: 240, above: true });
  const caps = catalogCapabilities ?? (resolvedBinding.runtime === agentStatus?.runtime ? agentStatus.capabilities : null);
  const hasModels = !!(caps?.models || caps?.providerModels || resolvedBinding.model);
  const searchable = page === 'model' && providerModels.length > 7;
  const effort = resolveComposerReasoning(resolvedBinding, agentStatus, catalogCapabilities, providerModels, providers);
  const runtimeLabel = agentStatus?.availableRuntimes?.find((runtime) => runtime.id === resolvedBinding.runtime)?.label || resolvedBinding.runtime;
  const modelLabel = providerModels.find((model) => model.id === resolvedBinding.model)?.label || resolvedBinding.model || 'Default model';
  const providerLabel = providers.find((provider) => provider.id === resolvedBinding.provider)?.label || resolvedBinding.provider || 'Default provider';
  const closeRef = useRef(onClose);
  const returnTarget = useRef<PickerPage>('runtime');
  const pageRef = useRef(page);
  useLayoutEffect(() => { closeRef.current = onClose; pageRef.current = page; });

  const dismiss = useCallback((restoreFocus: boolean) => {
    cancel();
    if (restoreFocus) anchor.trigger?.focus({ preventScroll: true });
    closeRef.current();
  }, [anchor.trigger, cancel]);

  const navigate = (next: PickerPage) => {
    cancel();
    if (next !== 'overview') returnTarget.current = next;
    setQuery('');
    setPage(next);
  };

  // Keep the same surface mounted while moving between lists. Focus follows
  // the current page, not catalog revalidation or streamed parent renders.
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [page, query]);

  useLayoutEffect(() => {
    const target = page === 'overview'
      ? bodyRef.current?.querySelector<HTMLButtonElement>(`[data-picker-page="${returnTarget.current}"]`)
      : searchRef.current ?? bodyRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    (target ?? bodyRef.current?.querySelector<HTMLElement>(focusableSelector))?.focus({ preventScroll: true });
  }, [page]);

  useLayoutEffect(() => {
    if (saving) return;
    const target = savingFocusRef.current;
    savingFocusRef.current = null;
    // Native disabled controls lose focus while an asynchronous save runs.
    if (target?.isConnected && document.activeElement === document.body) target.focus({ preventScroll: true });
  }, [saving]);

  useLayoutEffect(() => {
    if (page === 'overview' && !effort.adjustable && document.activeElement === document.body) {
      bodyRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus({ preventScroll: true });
    }
  }, [effort.adjustable, page]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const reposition = () => {
      const trigger = anchor.trigger?.getBoundingClientRect();
      const aboveEdge = trigger ? trigger.top - 6 : anchor.anchorBottom;
      const belowEdge = trigger ? trigger.bottom + 6 : anchor.y;
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width = viewport?.width ?? window.innerWidth;
      const aboveSpace = aboveEdge === undefined ? 0 : aboveEdge - viewportTop - 8;
      const belowSpace = viewportTop + height - belowEdge - 8;
      const above = aboveSpace >= Math.min(240, height / 2) || aboveSpace > belowSpace;
      // The exported cap belongs to the scrolling list, not its search/back chrome.
      const listHeight = parseFloat(getComputedStyle(surface).getPropertyValue('--m-maxHeight')) || 240;
      const chromeHeight = surface.offsetHeight - (contentRef.current?.offsetHeight ?? surface.offsetHeight);
      const maxHeight = Math.max(80, Math.min(listHeight + chromeHeight, above ? aboveSpace : belowSpace, height - 16));
      const rect = surface.getBoundingClientRect();
      const top = above && aboveEdge !== undefined ? aboveEdge - Math.min(rect.height, maxHeight) : belowEdge;
      const next = {
        left: Math.max(viewportLeft + 8, Math.min(anchor.align === 'end' ? (trigger?.right ?? anchor.x) - rect.width : trigger?.left ?? anchor.x, viewportLeft + width - rect.width - 8)),
        top: Math.max(viewportTop + 8, Math.min(top, viewportTop + height - Math.min(rect.height, maxHeight) - 8)),
        maxHeight,
        above,
      };
      setPosition((previous) => Object.keys(next).every((key) => previous[key as keyof typeof next] === next[key as keyof typeof next]) ? previous : next);
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    observer.observe(surface);
    if (anchor.trigger) observer.observe(anchor.trigger);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    window.visualViewport?.addEventListener('resize', reposition);
    window.visualViewport?.addEventListener('scroll', reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.visualViewport?.removeEventListener('resize', reposition);
      window.visualViewport?.removeEventListener('scroll', reposition);
    };
  }, [anchor, page, searchable]);

  useEffect(() => {
    mountedRef.current = true;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (surfaceRef.current?.contains(event.target) || anchor.trigger?.contains(event.target)) return;
      dismiss(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      if (pageRef.current !== 'overview') { setPage('overview'); setQuery(''); }
      else dismiss(true);
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', keyboard, true);
    return () => {
      mountedRef.current = false;
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', keyboard, true);
    };
  }, [anchor.trigger, dismiss, cancel]);

  useLayoutEffect(() => { cancel(); }, [resolvedBinding.runtime, resolvedBinding.provider, resolvedBinding.model, cancel]);

  const select = async (action: () => void | Promise<void>, nextPage = page) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSaveError(null);
    try {
      const result = action();
      if (result) {
        savingFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setSaving(true);
        await result;
      }
      if (mountedRef.current) navigate(nextPage);
    } catch (error) {
      if (mountedRef.current) setSaveError(error instanceof Error ? error.message : 'Could not save selection');
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Tab') {
      // Restore the trigger before native Tab advances into the composer.
      dismiss(true);
      return;
    }
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    if (input?.type === 'range') return;
    if (event.key === 'ArrowLeft' && !input && page !== 'overview') {
      event.preventDefault(); navigate('overview'); return;
    }
    if (event.key === 'ArrowRight' && !input && page === 'overview') {
      event.preventDefault(); (event.target as HTMLButtonElement).click(); return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    if (input && ['Home', 'End'].includes(event.key)) return;
    const options = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)') ?? []);
    const items = page !== 'overview' && options.length ? options
      : Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter((item) => item !== searchRef.current);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : current < 0 ? event.key === 'ArrowDown' ? 0 : items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[index].focus({ preventScroll: true });
    items[index].scrollIntoView?.({ block: 'nearest' });
  };

  const catalogStatus = (modelsLoading || modelsError || providerModels.length === 0) && (
    <div className="composer-picker-status" role="status">
      <span>{modelsError || (modelsLoading ? modelsWaiting ? 'Still loading models…' : 'Loading models…' : 'No models available')}</span>
      {(modelsError || modelsWaiting || !modelsLoading) && (
        <button type="button" className="composer-picker-icon" title={modelsError ? 'Retry' : 'Reload models'} aria-label={modelsError ? 'Retry' : 'Reload models'} onClick={() => {
          bodyRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus({ preventScroll: true });
          onRetryModels();
        }}>
          <RetryIcon />
        </button>
      )}
    </div>
  );
  const filteredModels = providerModels.filter((model) => `${model.label ?? ''} ${model.id} ${model.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const summaryRow = (target: PickerPage, label: string, value: string) => (
    <button type="button" className="composer-picker-row composer-picker-summary" data-picker-page={target}
      aria-label={`Select ${label.toLowerCase()}: ${value}`} onClick={() => navigate(target)} disabled={saving}>
      <span className="composer-picker-copy"><span className="composer-picker-caption">{label}</span><span className="composer-picker-value">{value}</span></span>
      <ChevronRightIcon />
    </button>
  );
  const option = (id: string, label: string, checked: boolean, action: () => void | Promise<void>, description?: string, disabled = false) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={checked} disabled={disabled || saving}
      className={`composer-picker-row${blinkingId === `${page}-${id}` ? ' ui-menu-blink' : ''}`}
      onClick={() => confirm(`${page}-${id}`, () => { if (checked) navigate('overview'); else void select(action, 'overview'); })}>
      <span className="composer-picker-copy"><span className="composer-picker-value">{label}</span>{description && <span className="composer-picker-caption">{description}</span>}</span>
      <span className="composer-picker-check">{checked && <CheckIcon />}</span>
    </button>
  );

  return (
    <PopoverSurface ref={surfaceRef} menuKind="composer" left={position.left} top={position.top} width="var(--m-width)" maxWidth="calc(100vw - 16px)" maxHeight={position.maxHeight}
      role="dialog" aria-label="Model settings" animate={false} className="composer-picker"
      style={{
        overflow: 'hidden',
        // Reserve the search page height so filtering cannot move its navigation.
        height: searchable ? position.maxHeight : undefined,
        transformOrigin: `${position.above ? 'bottom' : 'top'} ${anchor.align === 'end' ? 'right' : 'left'}`,
      }} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <div ref={bodyRef} onKeyDown={onKeyDown} data-keyboard={anchor.keyboard || undefined} className="composer-picker-body" aria-busy={saving}>
        {page !== 'overview' && (
          <div className="composer-picker-header">
            <button type="button" className="composer-picker-icon" aria-label="Back to model settings" title="Back" onClick={() => navigate('overview')}><ChevronLeftIcon /></button>
          </div>
        )}
        {searchable && <input ref={searchRef} type="search" className="composer-picker-search" aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => { cancel(); setQuery(event.target.value); }} />}
        <div ref={contentRef} className="composer-picker-content">
          {page === 'overview' ? (
            <>
              {summaryRow('runtime', 'Runtime', runtimeLabel)}
              {caps?.providerModels && onSaveProvider && providers.length > 0 && summaryRow('provider', 'Provider', providerLabel)}
              {hasModels && summaryRow('model', 'Model', modelLabel)}
              {effort.adjustable && <EffortControl key={JSON.stringify([resolvedBinding.runtime, resolvedBinding.provider, resolvedBinding.model, effort.levels])} levels={effort.levels} value={effort.value} disabled={saving}
                onSelect={(value) => select(() => onSaveReasoning(value))} />}
              {!caps && catalogStatus}
            </>
          ) : page === 'model' ? (
            <>
              {catalogStatus}
              <div role="menu" aria-label="Models" className="composer-picker-options">
                {resolvedBinding.model && !providerModels.some((model) => model.id === resolvedBinding.model) && !query && option('current', modelLabel, true, () => {}, 'Current model')}
                {filteredModels.map((model) => option(model.id, model.label || model.id, model.id === resolvedBinding.model, () => onSaveModel(model.id), model.description || (caps?.providerModels && model.label !== model.id ? model.id : undefined)))}
              </div>
              {query && !filteredModels.length && <div className="composer-picker-status" role="status">No matching models</div>}
            </>
          ) : page === 'runtime' ? (
            <div role="menu" aria-label="Runtimes" className="composer-picker-options">
              {(agentStatus?.availableRuntimes?.length ? agentStatus.availableRuntimes : [{ id: resolvedBinding.runtime, label: runtimeLabel, available: true }]).map((runtime) =>
                option(runtime.id, runtime.label || runtime.id, runtime.id === resolvedBinding.runtime, () => onSwitchRuntime(runtime.id), runtime.available ? undefined : 'Unavailable', !runtime.available))}
            </div>
          ) : (
            <div role="menu" aria-label="Providers" className="composer-picker-options">
              {providers.map((provider) => option(provider.id, provider.label || provider.id, provider.id === resolvedBinding.provider, () => onSaveProvider?.(provider.id), provider.hasKey === false ? 'No API key configured' : undefined))}
            </div>
          )}
          {saving && <div role="status" className="composer-picker-status">Saving…</div>}
          {saveError && <div role="alert" className="composer-picker-status composer-picker-error">{saveError}</div>}
        </div>
      </div>
    </PopoverSurface>
  );
}

function EffortControl({ levels, value, disabled, onSelect }: {
  levels: AgentReasoning[]; value?: AgentReasoning; disabled: boolean; onSelect: (value: AgentReasoning) => Promise<void>;
}) {
  const [preview, setPreview] = useState<AgentReasoning | null>(null);
  const dragging = useRef(false);
  const current = preview ?? value;
  const index = Math.max(0, levels.findIndex((level) => level === current));
  const label = current ? REASONING_LABELS[current] ?? current : 'Default';
  const commit = (next: AgentReasoning) => {
    if (next === value) { setPreview(null); return; }
    setPreview(next);
    void onSelect(next).finally(() => setPreview(null));
  };
  return (
    <div className="composer-picker-effort">
      <div className="composer-picker-effort-heading"><span>Thinking effort</span><span aria-live="polite">{label}</span></div>
      <input type="range" className="composer-picker-range" aria-label="Thinking effort" aria-valuetext={label} min={0} max={levels.length - 1} step={1} value={index}
        disabled={disabled || levels.length < 2} style={{ '--effort-progress': `${levels.length > 1 ? index / (levels.length - 1) * 100 : 0}%` } as React.CSSProperties}
        onPointerDown={(event) => { dragging.current = true; event.currentTarget.setPointerCapture?.(event.pointerId); }}
        onChange={(event) => { const next = levels[Number(event.target.value)]; setPreview(next); if (!dragging.current) commit(next); }}
        onPointerUp={(event) => { dragging.current = false; commit(levels[Number(event.currentTarget.value)]); }}
        onPointerCancel={() => { dragging.current = false; setPreview(null); }} />
      <div className="composer-picker-effort-stops" aria-hidden="true">
        {levels.map((level) => <span key={level} data-selected={current === level || undefined} />)}
      </div>
      <div className="composer-picker-effort-extents"><span>{REASONING_LABELS[levels[0]] ?? levels[0]}</span><span>{REASONING_LABELS[levels[levels.length - 1]] ?? levels[levels.length - 1]}</span></div>
    </div>
  );
}
