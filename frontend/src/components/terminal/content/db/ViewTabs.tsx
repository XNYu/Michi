import React, { useRef, useState } from 'react';
import { Calendar, ChartGantt, Code, Copy, Ellipsis, Kanban, LayoutGrid, List, Pencil, Plus, Table2, Trash2, type LucideIcon } from 'lucide-react';
import type { MichiDatabase, MichiDbView, MichiDbViewType } from 'michi-shared';
import { DbMenuItem, DbPopover } from './DbPopover';
import { VIEW_TYPE_LABEL, viewName } from './dbLabels';
import { addViewOp, duplicateViewOp, renameViewOp } from './dbOps';
import type { DbEdit } from './views/viewTypes';

export const VIEW_ICON: Record<MichiDbViewType, LucideIcon> = {
  table: Table2,
  board: Kanban,
  list: List,
  calendar: Calendar,
  gallery: LayoutGrid,
  timeline: ChartGantt,
  custom: Code,
};

/** What `+` offers. A custom view needs widgets, which are off. */
const NEW_VIEW_TYPES: MichiDbViewType[] = ['table', 'board', 'list', 'timeline', 'calendar', 'gallery'];

type MenuState = { kind: 'view'; view: MichiDbView; anchor: HTMLElement | { x: number; y: number } } | { kind: 'add'; anchor: HTMLElement } | null;

/**
 * The database's saved views as tabs, each with its type's icon. ←/→ move
 * between them; right-click or ⋯ renames, duplicates or deletes one; `+`
 * makes a new one of the chosen type and opens it, or (where someone can
 * build one) asks for a custom view.
 */
export function ViewTabs({
  db,
  view,
  edit,
  onSelect,
  panelId,
  tabId,
  onAddCustomView,
}: {
  db: MichiDatabase;
  view: MichiDbView;
  edit: DbEdit;
  onSelect: (id: string) => void;
  panelId: string;
  tabId: (id: string) => string;
  /** Offers Custom… in the add menu: a custom view is built for the person, not picked from a type. */
  onAddCustomView?: () => void;
}) {
  const [menu, setMenu] = useState<MenuState>(null);
  const [renaming, setRenaming] = useState<{ view: MichiDbView; anchor: HTMLElement } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const views = db.views;

  const add = (type: MichiDbViewType) => {
    setMenu(null);
    const { id, op } = addViewOp(db, type);
    void edit([op], `Added view ${VIEW_TYPE_LABEL[type]}`);
    onSelect(id);
  };
  const duplicate = (v: MichiDbView) => {
    setMenu(null);
    const { id, op } = duplicateViewOp(db, v);
    void edit([op], 'Duplicated the view');
    onSelect(id);
  };
  const remove = (v: MichiDbView) => {
    setMenu(null);
    const rest = views.filter((x) => x.id !== v.id);
    if (!rest.length) return;
    if (v.id === view.id) onSelect(rest[0].id);
    void edit([{ op: 'view.delete', id: v.id }], `Deleted view ${viewName(db, v)}`);
  };
  const tabOf = (v: MichiDbView) =>
    Array.from(list.current?.querySelectorAll<HTMLElement>('[data-view-id]') ?? []).find((el) => el.dataset.viewId === v.id) ?? null;

  const onKey = (event: React.KeyboardEvent, current: MichiDbView) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(current.id);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = views.findIndex((v) => v.id === current.id);
    const next = views[(index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length];
    onSelect(next.id);
    tabOf(next)?.focus();
  };

  return (
    <div className="michi-db-tabs">
      <div ref={list} role="tablist" aria-label="Views" className="michi-db-tabs__list">
        {views.map((v) => {
          const active = v.id === view.id;
          const Icon = VIEW_ICON[v.type];
          return (
            <button
              key={v.id}
              type="button"
              id={tabId(v.id)}
              role="tab"
              data-view-id={v.id}
              aria-selected={active}
              aria-controls={panelId}
              tabIndex={active ? 0 : -1}
              className="michi-db-tab"
              data-active={active ? 'true' : undefined}
              onClick={() => onSelect(v.id)}
              onKeyDown={(event) => onKey(event, v)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setMenu({ kind: 'view', view: v, anchor: { x: event.clientX, y: event.clientY } });
              }}
            >
              <Icon size={13} strokeWidth={1.7} aria-hidden="true" />
              <span>{viewName(db, v)}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="michi-db-icon-btn"
        aria-label={`More for ${viewName(db, view)}`}
        aria-haspopup="menu"
        onClick={(event) => { const anchor = event.currentTarget; setMenu({ kind: 'view', view, anchor }); }}
      >
        <Ellipsis size={14} strokeWidth={1.7} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="michi-db-icon-btn"
        aria-label="Add view"
        aria-haspopup="menu"
        onClick={(event) => { const anchor = event.currentTarget; setMenu({ kind: 'add', anchor }); }}
      >
        <Plus size={14} strokeWidth={1.7} aria-hidden="true" />
      </button>

      {menu?.kind === 'add' && (
        <DbPopover anchor={menu.anchor} label="Add view" role="menu" width={180} onClose={() => setMenu(null)}>
          {NEW_VIEW_TYPES.map((t) => {
            const Icon = VIEW_ICON[t];
            return <DbMenuItem key={t} icon={<Icon size={14} strokeWidth={1.7} />} label={VIEW_TYPE_LABEL[t]} onSelect={() => add(t)} />;
          })}
          {onAddCustomView && (
            <DbMenuItem
              icon={<Code size={14} strokeWidth={1.7} />}
              label={`${VIEW_TYPE_LABEL.custom}…`}
              onSelect={() => { setMenu(null); onAddCustomView(); }}
            />
          )}
        </DbPopover>
      )}
      {menu?.kind === 'view' && (
        <DbPopover anchor={menu.anchor} label={`${viewName(db, menu.view)} view`} role="menu" width={180} onClose={() => setMenu(null)}>
          <DbMenuItem
            icon={<Pencil size={14} strokeWidth={1.7} />}
            label="Rename"
            onSelect={() => {
              const v = menu.view;
              setMenu(null);
              onSelect(v.id);
              const anchor = tabOf(v);
              if (anchor) setRenaming({ view: v, anchor });
            }}
          />
          <DbMenuItem icon={<Copy size={14} strokeWidth={1.7} />} label="Duplicate" onSelect={() => duplicate(menu.view)} />
          <DbMenuItem icon={<Trash2 size={14} strokeWidth={1.7} />} label="Delete" danger disabled={views.length < 2} onSelect={() => remove(menu.view)} />
        </DbPopover>
      )}
      {renaming && (
        <RenameView
          db={db}
          view={renaming.view}
          anchor={renaming.anchor}
          onDone={(name) => {
            const v = renaming.view;
            setRenaming(null);
            if (name && name !== viewName(db, v)) void edit([renameViewOp(v, name)], 'Renamed the view');
          }}
        />
      )}
    </div>
  );
}

/** A small field under the tab: Enter or a press elsewhere saves, Esc gives up. */
function RenameView({ db, view, anchor, onDone }: { db: MichiDatabase; view: MichiDbView; anchor: HTMLElement; onDone: (name: string | null) => void }) {
  const [text, setText] = useState(viewName(db, view));
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save ? text.trim() || null : null);
  };
  return (
    <DbPopover anchor={anchor} label="Rename view" width={220} onClose={(reason) => finish(reason === 'outside')}>
      <input
        data-autofocus
        className="michi-db-input"
        aria-label="View name"
        value={text}
        maxLength={100}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            finish(true);
          }
        }}
      />
    </DbPopover>
  );
}
