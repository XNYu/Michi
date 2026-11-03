import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AgentModelInfo } from '../../../../services/api';
import { MenuItem, PopoverSurface } from '../../../ui/Popover';
import { useAnchoredPosition } from '../../../ui/useAnchoredPosition';
import { ChevronRightIcon } from '../../icons';
import { filterModelCatalog } from './modelCatalogFilter';

const GAP = 4;
const EDGE = 8;
const MIN_WIDTH = 320;
/** With less room than this below the trigger, the list opens above it when that side has more. */
const MIN_BELOW = 200;

interface Option {
  id: string;
  label: string;
  detail?: string;
}

interface Placement {
  left: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
  width: number;
}

/**
 * The Model setting: a trigger that looks like the row's other selects and
 * opens the catalog as a list. A long catalog gets a filter field at the top
 * of that list, so choosing a model is one control rather than a search box
 * stacked over a select. Arrows move, Enter picks, Esc or Tab closes.
 */
export function ModelCombobox({
  id,
  labelId,
  value,
  models,
  searchable,
  disabled = false,
  busy = false,
  placeholder,
  onSelect,
}: {
  id: string;
  /** The row's name, which labels the trigger. */
  labelId: string;
  value?: string;
  models: readonly AgentModelInfo[];
  searchable: boolean;
  disabled?: boolean;
  /**
   * A choice is saving: the trigger ignores presses but stays enabled, so
   * keyboard focus is still on it when the save finishes.
   */
  busy?: boolean;
  /** The trigger's text when no model is set. */
  placeholder: string;
  onSelect: (modelId: string) => void;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selected = value ? models.find((model) => model.id === value) : undefined;
  const label = selected?.label || value || placeholder;
  // Nothing to list and nothing saved: there is no choice to make.
  const inert = disabled || (models.length === 0 && !value);

  useEffect(() => {
    if (inert) setOpen(false);
  }, [inert]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        className="ui-select settings-row__select settings-model-combo__trigger"
        aria-labelledby={labelId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-busy={busy || undefined}
        disabled={inert}
        title={selected?.label && selected.label !== selected.id ? `${selected.label} (${selected.id})` : label}
        onClick={() => { if (!busy) setOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (!open && !busy && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="settings-model-combo__value">{label}</span>
        <ChevronRightIcon size={12} className="settings-model-combo__chevron" />
      </button>
      {open && triggerRef.current && (
        <ModelList
          listId={listId}
          trigger={triggerRef.current}
          value={value}
          models={models}
          searchable={searchable}
          onClose={close}
          onPick={(modelId) => {
            close(true);
            if (modelId !== value) onSelect(modelId);
          }}
        />
      )}
    </>
  );
}

function ModelList({
  listId,
  trigger,
  value,
  models,
  searchable,
  onClose,
  onPick,
}: {
  listId: string;
  trigger: HTMLButtonElement;
  value?: string;
  models: readonly AgentModelInfo[];
  searchable: boolean;
  onClose: (restoreFocus: boolean) => void;
  onPick: (modelId: string) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [placement, setPlacement] = useState<Placement | null>(null);
  const side = useRef<'below' | 'above' | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const options = useMemo<Option[]>(() => {
    const filtered = filterModelCatalog([...models], query).map((model) => ({
      id: model.id,
      label: model.label || model.id,
      detail: model.description || (model.label && model.label !== model.id ? model.id : undefined),
    }));
    // A saved model the catalog no longer lists leads the unfiltered list.
    if (value && !query.trim() && !models.some((model) => model.id === value)) {
      return [{ id: value, label: value, detail: 'Current model' }, ...filtered];
    }
    return filtered;
  }, [models, query, value]);

  const [activeId, setActiveId] = useState<string | null>(value ?? null);
  const activeIndex = Math.max(0, options.findIndex((option) => option.id === activeId));
  const active = options[activeIndex];
  // Ids by position: model ids hold characters ("/", ".") that make poor DOM ids.
  const optionDomId = (index: number) => `${listId}-option-${index}`;

  useLayoutEffect(() => {
    (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true });
  }, [searchable]);

  useLayoutEffect(() => {
    if (active) document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, activeIndex, listId]);

  useAnchoredPosition({
    anchor: trigger,
    surfaceRef,
    measure: () => {
      const box = trigger.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const width = Math.min(Math.max(box.width, MIN_WIDTH), viewportWidth - EDGE * 2);
      const below = viewportHeight - box.bottom - GAP - EDGE;
      const above = box.top - GAP - EDGE;
      // The side is picked once, so filtering never flips the list. Above, it
      // hangs from its bottom edge and shrinks toward the trigger.
      side.current ??= below >= MIN_BELOW || below >= above ? 'below' : 'above';
      const left = Math.max(EDGE, Math.min(box.right - width, viewportWidth - width - EDGE));
      const next: Placement = side.current === 'below'
        ? { left, top: box.bottom + GAP, maxHeight: Math.max(120, below), width }
        : { left, bottom: viewportHeight - box.top + GAP, maxHeight: Math.max(120, above), width };
      setPlacement((previous) => previous
        && previous.left === next.left && previous.top === next.top && previous.bottom === next.bottom
        && previous.maxHeight === next.maxHeight && previous.width === next.width ? previous : next);
    },
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Esc closes the list, not the Settings window under it.
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current(true);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (surfaceRef.current?.contains(target) || trigger.contains(target))) return;
      onCloseRef.current(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [trigger]);

  const moveTo = (index: number) => {
    if (options.length > 0) setActiveId(options[(index + options.length) % options.length].id);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // The page and the window under the list never see its keys.
    event.stopPropagation();
    const inField = event.target === searchRef.current;
    if (event.key === 'Tab') {
      // Back on the trigger, Tab carries on to the control after it.
      onClose(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveTo(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if ((event.key === 'Home' || event.key === 'End') && !inField) {
      event.preventDefault();
      moveTo(event.key === 'Home' ? 0 : options.length - 1);
    } else if (event.key === 'Enter' || (event.key === ' ' && !inField)) {
      event.preventDefault();
      if (active) onPick(active.id);
    }
  };

  const activeDescendant = active ? optionDomId(activeIndex) : undefined;
  const status = searchable && query.trim()
    ? options.length === 0 ? `No models match “${query.trim()}”.` : `${options.length} of ${models.length} models`
    : null;

  return (
    <PopoverSurface
      ref={surfaceRef}
      menuKind="composer"
      left={placement?.left ?? 0}
      top={placement ? placement.top : 0}
      bottom={placement?.bottom}
      width={placement?.width ?? MIN_WIDTH}
      maxHeight={placement?.maxHeight}
      className="settings-model-combo__popover"
      // Placed from the trigger in a layout effect, which re-renders before
      // paint. Not hidden meanwhile: a hidden field cannot take focus.
      style={{ overflow: 'hidden' }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="settings-model-combo__body" onKeyDown={onKeyDown}>
        {searchable && (
          <div className="michi-menu-search">
            <input
              ref={searchRef}
              type="search"
              aria-label="Filter models"
              aria-controls={listId}
              aria-activedescendant={activeDescendant}
              autoComplete="off"
              spellCheck={false}
              placeholder="Filter by name or ID…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                // The first match leads after every edit.
                setActiveId(null);
              }}
            />
          </div>
        )}
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Models"
          tabIndex={-1}
          aria-activedescendant={searchable ? undefined : activeDescendant}
          className="michi-menu-list settings-model-combo__list"
        >
          {options.map((option, index) => (
            <MenuItem
              key={option.id}
              id={optionDomId(index)}
              role="option"
              aria-selected={option.id === value}
              active={index === activeIndex}
              className="settings-model-combo__option"
              // Keep focus in the filter field while a row is pressed.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveId(option.id)}
              onClick={() => onPick(option.id)}
            >
              <span className="settings-model-combo__copy">
                <span className="settings-model-combo__label">{option.label}</span>
                {option.detail && <span className="settings-model-combo__detail">{option.detail}</span>}
              </span>
              <span className="michi-menu-glyph" aria-hidden="true">{option.id === value ? '✓' : ''}</span>
            </MenuItem>
          ))}
        </ul>
        {status && <div role="status" className="michi-menu-footer">{status}</div>}
      </div>
    </PopoverSurface>
  );
}
