import React, { useLayoutEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '../../../ui/controls';
import { PlusIcon, TrashIcon } from '../../icons';
import { MICHI_CHECKLIST_MAX_ITEMS, MICHI_HEADING_MAX, MICHI_TEXT_MAX, type ChecklistDraftItem } from './pageEdits';
import './michiPage.css';

/** Whether a click came from the keyboard (Enter or Space on the button): those report no clicks. */
const byKeyboard = (event: React.MouseEvent) => event.detail === 0;

const COUNT = new Intl.NumberFormat('en-US');

/** ⌘↵ / Ctrl↵ saves and Esc cancels; neither reaches the page (Esc there leaves it or clears the selection). */
function editorKeys(onSave: () => void, onCancel: () => void) {
  return (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    const save = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    if (!save && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (save) onSave();
    else onCancel();
  };
}

/** How much of a limit the words use, shown once they come close; past it, the editor will not save. */
function LengthCount({ used, max }: { used: number; max: number }) {
  if (used < max * 0.9) return null;
  const over = used > max;
  return (
    <span className="michi-doc-editor__count michi-doc-mono" data-over={over || undefined} aria-live="polite">
      {COUNT.format(used)} / {COUNT.format(max)}
      {over && ' · too long for one block'}
    </span>
  );
}

function EditorFooter({ busy, saveDisabled, onSave, onCancel, saveLabel = 'Save', cancelLabel = 'Cancel', count }: {
  busy: boolean;
  saveDisabled: boolean;
  onSave: (viaKeyboard: boolean) => void;
  onCancel: (viaKeyboard: boolean) => void;
  saveLabel?: string;
  cancelLabel?: string;
  count?: React.ReactNode;
}) {
  return (
    <div className="michi-doc-editor__foot">
      <span className="michi-doc-editor__hint" aria-hidden="true">
        <kbd className="michi-doc-kbd">⌘↵</kbd> {saveLabel}
        <kbd className="michi-doc-kbd">Esc</kbd> {cancelLabel}
      </span>
      {count}
      <span className="michi-doc-editor__spacer" />
      <Button variant="ghost" size="sm" onClick={(event) => onCancel(byKeyboard(event))} disabled={busy}>{cancelLabel}</Button>
      <Button variant="primary" size="sm" onClick={(event) => onSave(byKeyboard(event))} disabled={busy || saveDisabled}>{saveLabel}</Button>
    </div>
  );
}

/**
 * Said inside an open editor once the page under it was rearranged: Save
 * would be refused, so the person picks. Reapply sends the same change to
 * the page as it is now; Copy keeps the words on the clipboard.
 */
export function PageChangedNote({ busy, onReapply, onCopy, text = 'The page changed' }: {
  busy: boolean;
  onReapply: (viaKeyboard: boolean) => void;
  onCopy: () => void;
  text?: string;
}) {
  return (
    <div className="michi-doc-editor__changed" role="status">
      <TriangleAlert size={13} strokeWidth={1.8} aria-hidden="true" />
      <span className="michi-doc-editor__changed-text">{text}</span>
      <span className="michi-doc-editor__spacer" />
      <Button size="sm" onClick={(event) => onReapply(byKeyboard(event))} disabled={busy}>Reapply</Button>
      <Button variant="ghost" size="sm" onClick={onCopy}>Copy</Button>
    </div>
  );
}

/**
 * Said inside an open editor once the block under it says something else
 * (an agent or a person elsewhere rewrote it, or its piece id now names another paragraph). The
 * new words are shown; nothing is written over them unless the person picks
 * Replace while reading them. Add as new block below keeps both.
 */
export function BlockRewrittenNote({ busy, theirs, canReplace, onAddBelow, onReplace, onCopy }: {
  busy: boolean;
  /** What the block says now. */
  theirs: string;
  /** Whether the block is still one this editor can write (same kind, editable). */
  canReplace: boolean;
  onAddBelow: (viaKeyboard: boolean) => void;
  onReplace: (viaKeyboard: boolean) => void;
  onCopy: () => void;
}) {
  return (
    <div className="michi-doc-editor__changed michi-doc-editor__rewritten" role="status">
      <div className="michi-doc-editor__rewritten-head">
        <TriangleAlert size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="michi-doc-editor__changed-text">This block changed while you were editing. It now says:</span>
      </div>
      <blockquote className="michi-doc-editor__theirs" aria-label="What the block says now">{theirs}</blockquote>
      <div className="michi-doc-editor__rewritten-actions">
        <Button size="sm" onClick={(event) => onAddBelow(byKeyboard(event))} disabled={busy}>Add as new block below</Button>
        {canReplace && (
          <Button size="sm" variant="ghost" onClick={(event) => onReplace(byKeyboard(event))} disabled={busy}>Replace</Button>
        )}
        <Button variant="ghost" size="sm" onClick={onCopy}>Copy</Button>
      </div>
    </div>
  );
}

/** Focus the field and put the caret at its end, once, when the editor opens. */
function useOpenFocus<T extends HTMLInputElement | HTMLTextAreaElement>() {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return ref;
}

export interface EditorChrome {
  busy?: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  /** Save stays off, e.g. while the page changed under the editor. */
  saveDisabled?: boolean;
  /** Shown above the buttons (the page-changed note). */
  notice?: React.ReactNode;
  onCancel: (viaKeyboard: boolean) => void;
}

/**
 * One block's words in place: a text box for Markdown and callouts, one line
 * for a heading. Saving hands the words back; the caller decides what changed.
 * `measure` counts the words as they will be stored (a to-do list gains its
 * `- [ ] `), for `maxLength`. `title` (a callout's): its own line above the
 * words, handed back with them.
 */
export function TextBlockEditor({
  label,
  initial,
  title: initialTitle,
  multiline = true,
  placeholder,
  busy = false,
  saveLabel,
  cancelLabel,
  saveDisabled = false,
  notice,
  maxLength = MICHI_TEXT_MAX,
  measure,
  onChange,
  onSave,
  onCancel,
}: EditorChrome & {
  label: string;
  initial: string;
  title?: string;
  multiline?: boolean;
  placeholder?: string;
  maxLength?: number;
  measure?: (text: string) => number;
  onChange?: (text: string, title?: string) => void;
  onSave: (text: string, viaKeyboard: boolean, title?: string) => void;
}) {
  const [text, setText] = useState(initial);
  const [title, setTitle] = useState(initialTitle);
  const areaRef = useOpenFocus<HTMLTextAreaElement>();
  const lineRef = useOpenFocus<HTMLInputElement>();
  const used = measure ? measure(text) : text.length;
  const blocked = saveDisabled || used > maxLength;
  const save = (viaKeyboard: boolean) => { if (!busy && !blocked) onSave(text, viaKeyboard, title); };
  const onKeyDown = editorKeys(() => save(true), () => onCancel(true));
  const change = (next: string) => {
    setText(next);
    onChange?.(next, title);
  };
  const changeTitle = (next: string) => {
    setTitle(next);
    onChange?.(text, next);
  };
  return (
    <div className="michi-doc-editor" data-michi-editor="">
      {title !== undefined && (
        <input
          className="michi-doc-editor__field michi-doc-editor__field--line michi-doc-editor__title"
          aria-label="Title"
          placeholder="Title"
          value={title}
          maxLength={MICHI_HEADING_MAX}
          onChange={(event) => changeTitle(event.target.value)}
          onKeyDown={(event) => {
            // One line: plain Enter goes on to the words.
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              areaRef.current?.focus();
              return;
            }
            onKeyDown(event);
          }}
        />
      )}
      {multiline ? (
        <textarea
          ref={areaRef}
          className="michi-doc-editor__field"
          aria-label={label}
          placeholder={placeholder}
          value={text}
          maxLength={maxLength}
          rows={Math.min(14, Math.max(3, text.split('\n').length + 1))}
          onChange={(event) => change(event.target.value)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <input
          ref={lineRef}
          className="michi-doc-editor__field michi-doc-editor__field--line"
          aria-label={label}
          placeholder={placeholder}
          value={text}
          maxLength={maxLength}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            // One line: plain Enter saves too.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              save(true);
              return;
            }
            onKeyDown(event);
          }}
        />
      )}
      {notice}
      <EditorFooter
        busy={busy}
        saveDisabled={blocked}
        onSave={save}
        onCancel={onCancel}
        saveLabel={saveLabel}
        cancelLabel={cancelLabel}
        count={<LengthCount used={used} max={maxLength} />}
      />
    </div>
  );
}

/** A checklist's title and items, each item's words and tick editable; items can be added (up to Michi's 50) and removed. */
export function ChecklistEditor({
  label,
  title: initialTitle,
  items: initialItems,
  busy = false,
  saveLabel,
  cancelLabel,
  saveDisabled = false,
  notice,
  onChange,
  onSave,
  onCancel,
}: EditorChrome & {
  label: string;
  title: string;
  items: readonly ChecklistDraftItem[];
  onChange?: (title: string, items: ChecklistDraftItem[]) => void;
  onSave: (title: string, items: ChecklistDraftItem[], viaKeyboard: boolean) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [items, setItems] = useState<ChecklistDraftItem[]>(() => (
    initialItems.length ? initialItems.slice(0, MICHI_CHECKLIST_MAX_ITEMS) : [{ text: '', done: false }]
  ));
  const titleRef = useOpenFocus<HTMLInputElement>();
  const itemRefs = useRef<Array<HTMLInputElement | null>>([]);
  const focusItem = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (focusItem.current == null) return;
    itemRefs.current[focusItem.current]?.focus({ preventScroll: true });
    focusItem.current = null;
  });
  const full = items.length >= MICHI_CHECKLIST_MAX_ITEMS;
  const save = (viaKeyboard: boolean) => { if (!busy && !saveDisabled) onSave(title, items, viaKeyboard); };
  const onKeyDown = editorKeys(() => save(true), () => onCancel(true));
  const update = (nextTitle: string, nextItems: ChecklistDraftItem[]) => {
    setTitle(nextTitle);
    setItems(nextItems);
    onChange?.(nextTitle, nextItems);
  };
  const setItem = (index: number, next: Partial<ChecklistDraftItem>) =>
    update(title, items.map((it, i) => (i === index ? { ...it, ...next } : it)));
  const addAfter = (index: number) => {
    if (full) return;
    update(title, [...items.slice(0, index + 1), { text: '', done: false }, ...items.slice(index + 1)]);
    focusItem.current = index + 1;
  };
  const remove = (index: number) => {
    update(title, items.length > 1 ? items.filter((_, i) => i !== index) : [{ text: '', done: false }]);
    focusItem.current = Math.max(0, index - 1);
  };

  return (
    <div className="michi-doc-editor" data-michi-editor="" role="group" aria-label={label} onKeyDown={onKeyDown}>
      <input
        ref={titleRef}
        className="michi-doc-editor__field michi-doc-editor__field--line michi-doc-editor__title"
        aria-label="Checklist title"
        value={title}
        maxLength={MICHI_TEXT_MAX}
        onChange={(event) => update(event.target.value, items)}
      />
      <ul className="michi-doc-editor__items">
        {items.map((it, i) => (
          <li key={i}>
            <input
              type="checkbox"
              className="michi-doc-editor__tick"
              aria-label={`Done: ${it.text || `item ${i + 1}`}`}
              checked={it.done}
              onChange={(event) => setItem(i, { done: event.target.checked })}
            />
            <input
              ref={(el) => { itemRefs.current[i] = el; }}
              className="michi-doc-editor__field michi-doc-editor__field--line"
              aria-label={`Item ${i + 1}`}
              value={it.text}
              placeholder="To-do"
              maxLength={MICHI_TEXT_MAX}
              onChange={(event) => setItem(i, { text: event.target.value })}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.stopPropagation();
                  addAfter(i);
                } else if (event.key === 'Backspace' && !it.text && items.length > 1) {
                  event.preventDefault();
                  event.stopPropagation();
                  remove(i);
                }
              }}
            />
            <button type="button" className="michi-doc-editor__remove" aria-label={`Remove item ${i + 1}`} onClick={() => remove(i)}>
              <TrashIcon size={12} />
            </button>
          </li>
        ))}
      </ul>
      <div className="michi-doc-editor__add-row">
        <button type="button" className="michi-doc-editor__add" disabled={full} onClick={() => addAfter(items.length - 1)}>
          <PlusIcon size={12} /> Add item
        </button>
        {full && <span className="michi-doc-editor__count michi-doc-mono">{MICHI_CHECKLIST_MAX_ITEMS} items at most</span>}
      </div>
      {notice}
      <EditorFooter
        busy={busy}
        saveDisabled={saveDisabled}
        onSave={save}
        onCancel={onCancel}
        saveLabel={saveLabel}
        cancelLabel={cancelLabel}
      />
    </div>
  );
}
