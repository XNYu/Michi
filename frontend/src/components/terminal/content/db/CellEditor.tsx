import React, { useEffect, useRef, useState } from 'react';
import { Check, MoveRight } from 'lucide-react';
import type { MichiDatabase, MichiDbColumn, MichiDbEditOp, MichiDbRow } from 'michi-shared';
import { DbPopover } from './DbPopover';
import { OptionPill } from './CellView';
import { convertValue, isDateValue, writableOptions, type CellValue } from './dbModel';
import { columnName, optionName } from './dbLabels';
import { AUTO_STATE } from './dbOps';
import { TASK_LIMITS } from 'michi-shared';
import { ThreadStateDot, type MichiDotKind } from '../ThreadStateDot';
import { liveConversation, threadCardKind, useLiveThreads, type ConversationChoice } from './liveThreads';

/** `ops` go before the cell's own change: a new option has to exist before a cell can hold it. */
export interface CellEditorProps {
  db: MichiDatabase;
  column: MichiDbColumn;
  value: CellValue | undefined;
  /** The row being edited, for a picker whose choices depend on it (a task's workspace on All tasks). */
  row?: MichiDbRow;
  /** Where a picker hangs (the cell). */
  anchor?: HTMLElement | null;
  onSave(value: CellValue, ops?: MichiDbEditOp[]): void;
  onCancel(): void;
  /** A pick Michi would not take (All threads' worked-out statuses): says why. */
  onRefused?(reason: string): void;
}

export const composing = (event: React.KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;
/** Keys the page listens for (Esc closes the peek or clears a selection, ↑/↓ move the peek) stay with the editor. */
const own = (event: React.KeyboardEvent) => event.stopPropagation();

/** Edits one cell where it sits: Enter saves, Esc gives up; leaving a text box saves it. */
export function CellEditor(props: CellEditorProps) {
  switch (props.column.type) {
    case 'select':
    case 'multi':
    case 'app':
      return <OptionsEditor {...props} />;
    case 'threads':
      return <ThreadsEditor {...props} />;
    case 'date':
      return <DateEditor {...props} />;
    case 'number':
    case 'progress':
      return <NumberEditor {...props} />;
    default:
      return <TextEditor {...props} />;
  }
}

function TextEditor({ db, column, value, onSave, onCancel }: CellEditorProps) {
  const start = typeof value === 'string' ? value : value == null ? '' : String(value);
  const [text, setText] = useState(start);
  const [bad, setBad] = useState<string | null>(null);
  const done = useRef(false);
  const finish = (save: boolean): boolean => {
    if (done.current) return true;
    if (!save || text === start) {
      done.current = true;
      onCancel();
      return true;
    }
    const r = convertValue(text, column.type, column.options);
    if (!r.ok) {
      setBad(column.type === 'url' ? "That isn't a link" : column.type === 'image' ? 'Only https image links' : "That doesn't fit here");
      return false;
    }
    done.current = true;
    onSave(r.value);
    return true;
  };
  return (
    <span className="michi-db-editor">
      <input
        autoFocus
        className="michi-db-input"
        aria-label={`Edit ${columnName(db, column)}`}
        aria-invalid={bad ? true : undefined}
        value={text}
        onChange={(event) => { setText(event.currentTarget.value); setBad(null); }}
        onBlur={() => {
          // Leaving with a value that does not fit gives it up instead of saving nothing.
          if (!finish(true)) {
            done.current = true;
            onCancel();
          }
        }}
        onKeyDown={(event) => {
          own(event);
          if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
          } else if (event.key === 'Enter' && !composing(event)) {
            event.preventDefault();
            finish(true);
          }
        }}
      />
      {bad && <span className="michi-db-editor__error" role="alert">{bad}</span>}
    </span>
  );
}

/** What typed number text means: empty clears the cell; anything that is not a number is refused. Progress is typed in percent. */
export function parseNumberText(text: string, pct: boolean): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (t === '') return { ok: true, value: null };
  const n = Number(t.replace(/[,%\s]/g, ''));
  if (!Number.isFinite(n)) return { ok: false };
  return { ok: true, value: pct ? Math.min(1, Math.max(0, n / 100)) : n };
}

/** Enter saves a number (or clears the cell when empty) and stays open on anything else; leaving with a non-number gives it up. */
function NumberEditor({ db, column, value, onSave, onCancel }: CellEditorProps) {
  const pct = column.type === 'progress';
  const start = typeof value === 'number' ? String(pct ? Math.round(value * 1000) / 10 : value) : '';
  const [text, setText] = useState(start);
  const [bad, setBad] = useState(false);
  const done = useRef(false);
  const finish = (save: boolean): boolean => {
    if (done.current) return true;
    if (!save || text.trim() === start) {
      done.current = true;
      onCancel();
      return true;
    }
    const r = parseNumberText(text, pct);
    if (!r.ok) {
      setBad(true);
      return false;
    }
    done.current = true;
    onSave(r.value);
    return true;
  };
  return (
    <span className="michi-db-editor">
      <input
        autoFocus
        inputMode="decimal"
        className="michi-db-input michi-db-mono"
        aria-label={`Edit ${columnName(db, column)}`}
        aria-invalid={bad || undefined}
        value={text}
        onChange={(event) => { setText(event.currentTarget.value); setBad(false); }}
        onBlur={() => {
          if (!finish(true)) {
            done.current = true;
            onCancel();
          }
        }}
        onKeyDown={(event) => {
          own(event);
          if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
          } else if (event.key === 'Enter' && !composing(event)) {
            event.preventDefault();
            finish(true);
          }
        }}
      />
      {pct && <span className="michi-db-editor__suffix" aria-hidden="true">%</span>}
      {bad && <span className="michi-db-editor__error" role="alert">{pct ? 'Type a percent, like 40' : 'Type a number'}</span>}
    </span>
  );
}

/** A day, or with → a start and an end. Enter (or leaving the editor) saves; Esc gives up; clearing the start empties the cell. */
function DateEditor({ db, column, value, onSave, onCancel }: CellEditorProps) {
  const v = isDateValue(value) ? value : typeof value === 'string' && value ? { start: value } : null;
  const day = (s: string | undefined) => (s ? s.slice(0, 10) : '');
  const [start, setStart] = useState(day(v?.start));
  const [end, setEnd] = useState(day(v?.end));
  const [range, setRange] = useState(!!v?.end);
  const done = useRef(false);
  const box = useRef<HTMLSpanElement>(null);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (!save) {
      onCancel();
      return;
    }
    if (!start) {
      if (v) onSave(null);
      else onCancel();
      return;
    }
    const next = range && end && end !== start ? (end < start ? { start: end, end: start } : { start, end }) : { start };
    if (v && day(v.start) === next.start && day(v.end) === day((next as { end?: string }).end)) {
      onCancel();
      return;
    }
    onSave(next);
  };
  const keys = (event: React.KeyboardEvent) => {
    own(event);
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    } else if (event.key === 'Enter' && !composing(event)) {
      event.preventDefault();
      finish(true);
    }
  };
  const name = columnName(db, column);
  return (
    <span
      ref={box}
      className="michi-db-editor michi-db-editor--date"
      onBlur={(event) => {
        const to = event.relatedTarget as Node | null;
        if (!to || !box.current?.contains(to)) finish(true);
      }}
    >
      <input autoFocus type="date" className="michi-db-input michi-db-mono" aria-label={`Edit ${name}`} value={start} onChange={(event) => setStart(event.currentTarget.value)} onKeyDown={keys} />
      {range && (
        <input type="date" className="michi-db-input michi-db-mono" aria-label={`Edit ${name} end`} value={end} onChange={(event) => setEnd(event.currentTarget.value)} onKeyDown={keys} />
      )}
      <button
        type="button"
        className="michi-db-icon-btn"
        aria-label={range ? 'No end date' : 'Add an end date'}
        aria-pressed={range}
        onKeyDown={keys}
        onClick={() => setRange((r) => !r)}
      >
        <MoveRight size={13} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </span>
  );
}

/**
 * Options to pick from, typed to narrow. Single: picking saves. Multi: picks
 * add up and are saved when the list closes or on Enter with nothing typed.
 * Typing a name that is not there offers to make it (not on built-in
 * columns). On All threads' status only In progress and Done can be picked.
 */
function OptionsEditor({ db, column, value, anchor, onSave, onCancel, onRefused }: CellEditorProps) {
  const multi = column.type === 'multi';
  const options = column.options ?? [];
  const allowed = writableOptions(db, column);
  const start = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
  const [picked, setPicked] = useState<string[]>(start);
  const [search, setSearch] = useState('');
  const done = useRef(false);
  const fallbackAnchor = useRef<HTMLSpanElement>(null);

  const finish = (save: boolean, list: string[] = picked, ops?: MichiDbEditOp[]) => {
    if (done.current) return;
    done.current = true;
    if (!save || (!ops && list.join('\n') === start.join('\n'))) {
      onCancel();
      return;
    }
    onSave(multi ? (list.length ? list : null) : list[0] ?? null, ops);
  };
  const q = search.trim();
  const ql = q.toLowerCase();
  const shown = options.filter((o) => !ql || o.value.toLowerCase().includes(ql) || optionName(db, column, o.value).toLowerCase().includes(ql));
  const exact = options.find((o) => o.value === q || o.label === q);
  const creatable = !!q && !exact && !column.builtin && !allowed;

  const locked = (v: string) => !!allowed && !allowed.has(v);
  const pick = (v: string) => {
    if (locked(v)) {
      onRefused?.(AUTO_STATE);
      return;
    }
    if (!multi) {
      finish(true, [v]);
      return;
    }
    setPicked((list) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]));
    setSearch('');
  };
  const create = () => {
    // An App cell is just a name; other columns gain the option first.
    const ops: MichiDbEditOp[] = column.type === 'app' ? [] : [{ op: 'option.add', id: column.id, option: { value: q } }];
    finish(true, multi ? [...picked, q] : [q], ops.length ? ops : undefined);
  };

  return (
    <span ref={fallbackAnchor} className="michi-db-editor michi-db-editor--pick">
      <DbPopover
        anchor={anchor ?? fallbackAnchor.current ?? { x: 0, y: 0 }}
        label={`Edit ${columnName(db, column)}`}
        width={240}
        restoreFocus={false}
        onClose={(reason) => finish(reason === 'outside')}
      >
        <div className="michi-db-picker">
          <input
            autoFocus
            data-autofocus
            className="michi-db-input"
            aria-label={`Find an option for ${columnName(db, column)}`}
            placeholder={picked.length && multi ? '' : 'Find an option'}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !composing(event)) {
                event.preventDefault();
                // The first option that can be picked; a worked-out status never is.
                const first = q ? shown.find((o) => !locked(o.value)) : undefined;
                if (first) pick(first.value);
                else if (creatable) create();
                else if (q && shown.length) onRefused?.(AUTO_STATE);
                else finish(true);
              }
            }}
          />
          {multi && picked.length > 0 && (
            <span className="michi-db-pills michi-db-picker__picked">
              {picked.map((v) => <OptionPill key={v} db={db} column={column} value={v} />)}
            </span>
          )}
          <div className="michi-db-picker__list" role="listbox" aria-label={columnName(db, column)} aria-multiselectable={multi || undefined}>
            {shown.map((o) => {
              const off = locked(o.value);
              const on = picked.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={on}
                  aria-disabled={off || undefined}
                  className="michi-db-picker__option"
                  data-locked={off ? 'true' : undefined}
                  onClick={() => pick(o.value)}
                >
                  <OptionPill db={db} column={column} value={o.value} />
                  {on && <Check size={13} strokeWidth={2} aria-hidden="true" />}
                </button>
              );
            })}
            {creatable && (
              <button type="button" role="option" aria-selected={false} className="michi-db-picker__option" onClick={create}>
                Create “{q}”
              </button>
            )}
            {!shown.length && !creatable && <span className="michi-db-picker__empty">{options.length ? 'No match' : 'No options yet'}</span>}
          </div>
        </div>
      </DbPopover>
    </span>
  );
}

/**
 * The workspace's conversations to link, typed to narrow; linked ones are
 * ticked, and a tick undone unlinks it. Closing the list or Enter with
 * nothing typed saves the links; Esc gives up. One linked but no longer here
 * can only be unlinked.
 */
function ThreadsEditor({ db, column, value, row, anchor, onSave, onCancel }: CellEditorProps) {
  const live = useLiveThreads();
  const load = live?.loadConversations;
  const start = Array.isArray(value) ? value : [];
  const [picked, setPicked] = useState<string[]>(start);
  const [search, setSearch] = useState('');
  const [choices, setChoices] = useState<ConversationChoice[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The row it opened on: its choices are read once, for that row.
  const rowRef = useRef(row);
  const done = useRef(false);
  const fallbackAnchor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let current = true;
    if (!load) {
      setChoices([]);
      return undefined;
    }
    load(rowRef.current).then(
      (list) => { if (current) setChoices(list); },
      () => { if (current) { setFailed(true); setChoices([]); } },
    );
    return () => { current = false; };
  }, [load]);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (!save || picked.join('\n') === start.join('\n')) {
      onCancel();
      return;
    }
    onSave(picked.length ? picked : null);
  };
  const toggle = (id: string) => setPicked((list) => (list.includes(id)
    ? list.filter((x) => x !== id)
    : list.length >= TASK_LIMITS.threads ? list : [...list, id]));
  const q = search.trim().toLowerCase();
  const offered = new Set((choices ?? []).map((choice) => choice.nodeId));
  const shown = (choices ?? []).filter((choice) => !q || choice.title.toLowerCase().includes(q));
  // Linked ones outside the newest conversations: by their live title, or no longer here.
  const others = [...new Set([...start, ...picked])].filter((id) => !offered.has(id));
  const full = picked.length >= TASK_LIMITS.threads;
  const option = (id: string, title: React.ReactNode, kind: MichiDotKind, missing = false) => {
    const on = picked.includes(id);
    return (
      <button
        key={id}
        type="button"
        role="option"
        aria-selected={on}
        aria-disabled={!on && full ? true : undefined}
        className="michi-db-picker__option"
        onClick={() => toggle(id)}
      >
        <span className="michi-db-thread" data-missing={missing ? 'true' : undefined}>
          <ThreadStateDot kind={kind} size={8} />
          <span className="michi-db-thread__title">{title}</span>
        </span>
        {on && <Check size={13} strokeWidth={2} aria-hidden="true" />}
      </button>
    );
  };

  return (
    <span ref={fallbackAnchor} className="michi-db-editor michi-db-editor--pick">
      <DbPopover
        anchor={anchor ?? fallbackAnchor.current ?? { x: 0, y: 0 }}
        label={`Edit ${columnName(db, column)}`}
        width={320}
        restoreFocus={false}
        onClose={(reason) => finish(reason === 'outside')}
      >
        <div className="michi-db-picker">
          <input
            autoFocus
            data-autofocus
            className="michi-db-input"
            aria-label="Find a conversation"
            placeholder="Find a conversation"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || composing(event)) return;
              event.preventDefault();
              if (q) {
                const first = shown[0];
                if (first) {
                  toggle(first.nodeId);
                  setSearch('');
                }
              } else finish(true);
            }}
          />
          <div className="michi-db-picker__list" role="listbox" aria-label={columnName(db, column)} aria-multiselectable>
            {!q && others.map((id) => {
              const item = liveConversation(live, id);
              return item ? option(id, item.title, threadCardKind(item)) : option(id, live?.loaded ? 'No longer here' : 'Conversation', 'idea', true);
            })}
            {shown.map((choice) => option(choice.nodeId, choice.title, choice.state ?? 'idea'))}
            {choices === null && <span className="michi-db-picker__empty">Reading conversations…</span>}
            {choices !== null && !shown.length && !(!q && others.length) && (
              <span className="michi-db-picker__empty">{failed ? "Couldn't read this workspace's conversations" : q ? 'No match' : 'No conversations in this workspace'}</span>
            )}
          </div>
          {full && <span className="michi-db-picker__empty" role="status">A task links up to {TASK_LIMITS.threads} conversations</span>}
        </div>
      </DbPopover>
    </span>
  );
}
