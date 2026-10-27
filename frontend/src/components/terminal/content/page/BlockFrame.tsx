import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CornerUpLeft,
  GripVertical,
  Hash,
  Link2,
  MessageSquare,
  SquareCheck,
  TriangleAlert,
  Type,
} from 'lucide-react';
import type { MichiPageBlock } from 'michi-shared';
import type { MichiPageEditOp } from './editorTypes';
import type { MichiNoticeTone } from './editorTypes';
import { BranchIcon, CopyIcon, DocIcon, EditIcon, PlusIcon, TrashIcon } from '../../icons';
import { HoverTip } from '../../../ui/Popover';
import { AskPopover, BLOCK_SUGGESTIONS } from './AskPopover';
import { BlockRewrittenNote, ChecklistEditor, PageChangedNote, TextBlockEditor } from './BlockEditor';
import { MichiBlock } from './MichiBlock';
import { MichiMenu, type MichiMenuEntry, type MichiMenuItem } from './MichiMenu';
import { SourcesPopover, type SourceRow } from './SourcesPopover';
import type { MichiBlockCtx } from './blockTypes';
import { blockFullText, blockLabel, objects, str } from './michiPageModel';
import {
  MICHI_HEADING_MAX,
  MICHI_TEXT_MAX,
  type EditorDraft,
  type InsertKind,
  blockFingerprint,
  blockIdOf,
  checklistChanges,
  checklistItems,
  deleteOps,
  draftMarkdown,
  draftText,
  insertMarkdown,
  insertOp,
  isEditableBlock,
  isEditedBlock,
  releaseOp,
  staleTargetOf,
  textChanges,
  updateOp,
} from './pageEdits';
import './michiPage.css';

/** How Michi answered a page edit: done, refused because the page was rearranged, or the block is no longer there. */
export type ApplyResult = 'ok' | 'stale' | 'gone' | 'failed';

/** What an editor whose block left the page leaves behind: its words as Markdown, so they can go back on the page. */
export interface OrphanDraft {
  /** What the editor was editing or adding. */
  label: string;
  markdown: string;
  /** The words as typed, for Copy. */
  text: string;
}

/**
 * What the workspace document lends its blocks. One object per page version
 * (it changes only with `generatedAt`), so memoized blocks do not redraw on
 * every Michi poll.
 */
export interface PageChrome {
  /** Optional action capabilities; omitted fields retain the Michi behavior. */
  capabilities?: { ask?: boolean; branch?: boolean; sources?: boolean; copyLink?: boolean; select?: boolean; drag?: boolean };
  projectId: string;
  /** The stored page's version; editors open on it and send it back. */
  generatedAt: number;
  /** A question about the block, sent to the Michi assistant with the block attached. */
  ask(block: MichiPageBlock, question: string): void;
  /** Set: Ask hands the block to an assistant window instead of opening the question popover. */
  askAssistant?(block: MichiPageBlock): void;
  /** A new Michi thread with the block quoted in its composer. */
  branch(block: MichiPageBlock): void;
  /**
   * Sends a page edit. `at` is the version an editor opened on; an editor
   * says itself that the page changed, so only edits without one get a notice.
   */
  apply(ops: MichiPageEditOp[], label: string, at?: number): Promise<ApplyResult>;
  /** `tone` defaults to plain information. */
  notice(text: string, tone?: MichiNoticeTone): void;
  /** The blocks' whole text to the clipboard. */
  copy(blocks: MichiPageBlock[]): void;
  /** Words to the clipboard; `what` names them in the notice ("Copied your text"). */
  copyText(text: string, what: string): void;
  /** A link that opens this page at the block. */
  copyLink(blockId: string): void;
  sources(block: MichiPageBlock): SourceRow[];
  openThread(threadId: string): void;
  /** True while a move is on its way to Michi; the next one waits for the page to show it. */
  moving(): boolean;
  move(id: string, step: -1 | 1): void;
  select(id: string, mode: 'toggle' | 'extend'): void;
  /** A press on the margin starts selecting the blocks the pointer then passes over. */
  marginDown(id: string): void;
  marginEnter(id: string): void;
  /** A press on ⋮⋮ may become a drag that reorders the block. */
  dragStart(id: string, event: React.PointerEvent): void;
  /** Whether the press that just ended was a drag; reading it clears it. */
  takeDragged(): boolean;
  /** An open editor's block left the page (the agent rearranged it): the page keeps the words. */
  orphan(draft: OrphanDraft): void;
  /** The id of the block or piece that now says what `blockFingerprint` recorded, wherever it moved; null when none does. */
  findBlock(fingerprint: string): string | null;
  /** More kinds of block the Add menu offers below `afterId` (databases). `anchor`: the Other blocks button the menu hangs from, for a picker that follows it. */
  addEntries?(afterId: string, anchor: HTMLElement | null): MichiMenuEntry[];
  /** Native hosts supply the actions their persisted content supports. */
  menuEntries?(block: MichiPageBlock, actions: { ask(): void; sources(): void }): MichiMenuEntry[];
}

/**
 * The block an editor opened on (an edit) or below (an insert), as it read
 * then: its id, its words with the block it was cut from (`fingerprint`,
 * which finds it again wherever it moved) and its words alone (`words`).
 */
interface Opened {
  id: string | null;
  fingerprint: string;
  words: string;
}

/**
 * An open editor. `at` is the page version it opened on; `conflict` that Michi
 * refused its save as stale. An edit remembers the kind of the block it opened
 * on and what it said, an insert what the block it goes under said (`anchor`):
 * the same id may later name other words.
 */
type Mode =
  | { kind: 'edit'; at: number; type: string; opened: Opened; conflict?: boolean }
  | { kind: 'insert'; insert: InsertKind; at: number; anchor: Opened; conflict?: boolean };

type Popup = 'ask' | 'sources' | 'menu' | 'add' | null;

/** What the Add menu adds below a block; each is written as Markdown (Michi adds nothing else by hand). */
export const ADD_ITEMS: ReadonlyArray<{ kind: InsertKind; label: string; glyph: React.ReactNode }> = [
  { kind: 'text', label: 'Text', glyph: <Type size={14} strokeWidth={1.7} /> },
  { kind: 'heading', label: 'Heading', glyph: <Hash size={14} strokeWidth={1.7} /> },
  { kind: 'todo', label: 'To-do', glyph: <SquareCheck size={14} strokeWidth={1.7} /> },
  { kind: 'callout', label: 'Callout', glyph: <TriangleAlert size={14} strokeWidth={1.7} /> },
];

const INSERT_EDITOR: Record<InsertKind, { label: string; placeholder: string; multiline: boolean }> = {
  text: { label: 'New text', placeholder: 'Write something; Markdown works', multiline: true },
  heading: { label: 'New heading', placeholder: 'Heading', multiline: false },
  todo: { label: 'New to-do list', placeholder: 'One to-do per line', multiline: true },
  callout: { label: 'New callout', placeholder: 'Note', multiline: true },
};

const EDITED_HINT = 'You changed this block; the agent keeps it as it is when it rearranges the page';
const CHANGED_TEXT = 'The page changed while you were editing';

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

const TOOLBAR_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * One page block with its chrome: in the left margin a checkbox (top-level
 * blocks), + (add below) and ⋮⋮ (the block menu; drag it to reorder), and on
 * hover or focus a toolbar with Ask, Branch, Sources, Edit and ⋯ (one tab
 * stop; arrow keys move along it). Edit turns the block into its editor in
 * place. Without `chrome` the block is drawn bare. Memoized: with stable
 * props a Michi poll does not redraw the page.
 */
export const BlockFrame = memo(function BlockFrame({
  id,
  block,
  ctx,
  chrome,
  index,
  count = 0,
  selected = false,
  dragging = false,
  segmentOf,
  renderBlock,
  renderDecorations,
}: {
  /** DOM id the outline scrolls to. */
  id?: string;
  block: MichiPageBlock;
  ctx: MichiBlockCtx;
  chrome: PageChrome | null;
  /** The block's place among the page's top-level blocks; nested blocks have none (no selection, no moving). */
  index?: number;
  count?: number;
  selected?: boolean;
  /** Being dragged to a new place. */
  dragging?: boolean;
  /** The agent's Markdown block this is one piece of. */
  segmentOf?: string;
  /** Optional renderer supplied by another page adapter; Michi keeps its renderer by default. */
  renderBlock?: (block: MichiPageBlock, ctx: MichiBlockCtx) => React.ReactNode;
  /** Native marks and proposal UI stay outside Michi's source/edit metadata model. */
  renderDecorations?: (block: MichiPageBlock) => React.ReactNode;
}) {
  const blockId = blockIdOf(block);
  const label = blockLabel(block);
  const top = index != null;
  const askRef = useRef<HTMLButtonElement>(null);
  const sourcesRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const insertTypeRef = useRef<HTMLButtonElement>(null);
  const insertFocusRef = useRef(false);
  const [insertHasText, setInsertHasText] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [menuFrom, setMenuFrom] = useState<'handle' | 'more'>('handle');
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  // Deleted: drawn faded and out of reach until the page reads itself again and drops it.
  const [removed, setRemoved] = useState(false);
  const [rove, setRove] = useState(0);

  // What the open editor holds, kept as it is typed so it outlives the editor (Copy, Reapply, the page's rescue).
  const draftRef = useRef<EditorDraft | null>(null);
  const openedRef = useRef('');
  // One request at a time from this block, so a held ⌫ cannot send a second delete.
  const runningRef = useRef(false);

  // A click inside a block focuses it too; only a block reached with the keyboard deletes on ⌫.
  const pressedRef = useRef(false);
  const keyFocusRef = useRef(false);
  const focusViaRef = useRef<'keyboard' | 'pointer' | null>(null);

  // Read when the block leaves the page with its editor open.
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;
  const blockRef = useRef(block);
  blockRef.current = block;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => () => {
    const m = modeRef.current;
    const draft = draftRef.current;
    const c = chromeRef.current;
    if (!m || !draft || !c || draftText(draft).trim() === openedRef.current.trim()) return;
    const markdown = draftMarkdown(m.kind === 'edit' ? m.type : m.insert, draft);
    if (!markdown) return;
    c.orphan({
      label: m.kind === 'edit' ? blockLabel(blockRef.current) : INSERT_EDITOR[m.insert].label,
      markdown,
      text: draftText(draft),
    });
  }, []);

  // Out of reach for pointer and keyboard while it goes.
  useEffect(() => { frameRef.current?.toggleAttribute('inert', removed); }, [removed]);

  const sourceCount = chrome?.capabilities?.sources === false ? 0 : chrome?.capabilities?.sources === true ? chrome.sources(block).length : objects(block.sources).filter((s) => str(s.nodeId).trim()).length;
  const canAsk = chrome?.capabilities?.ask !== false;
  const canBranch = chrome?.capabilities?.branch !== false;
  const canCopyLink = chrome?.capabilities?.copyLink !== false;
  const canSelect = chrome?.capabilities?.select !== false;
  const canDrag = chrome?.capabilities?.drag !== false;
  const editable = !!chrome && isEditableBlock(block);
  const edited = isEditedBlock(block);
  const note = staleTargetOf(block) != null;
  // A text block with no words shows nothing; a page may leave it out of its flow (spaces.css).
  const empty = (block.type === 'markdown' || block.type === 'text') && !str(block.text).trim();
  const editing = mode?.kind === 'edit';
  const fingerprint = blockFingerprint(block, segmentOf);
  const words = blockFingerprint(block);
  /**
   * Whether this block still says what an editor read when it opened. Under
   * the same id the words alone decide: a piece may since have become a block
   * of its own, saying the same. The block it was cut from only counts for an
   * id that changed.
   */
  const stillSays = (opened: Opened) => (opened.id != null && opened.id === blockId
    ? opened.words === words
    : opened.fingerprint === fingerprint);
  // The block under an open edit no longer says what the editor opened on (someone rewrote it,
  // or a piece id now names another paragraph): Save and Reapply would write over other words.
  const rewritten = mode?.kind === 'edit' && !stillSays(mode.opened);
  // Michi refused the save, or the page was rearranged since the editor opened: Save would be refused.
  const changed = !!mode && !!chrome && !rewritten && (mode.conflict === true || chrome.generatedAt !== mode.at);

  // Closing an editor hands focus back to its block, so the keyboard stays where it was;
  // ⌫ there deletes only when the editor was closed from the keyboard.
  const closeEditor = useCallback((viaKeyboard: boolean) => {
    setMode(null);
    draftRef.current = null;
    openedRef.current = '';
    keyFocusRef.current = viaKeyboard;
    focusViaRef.current = viaKeyboard ? 'keyboard' : 'pointer';
    frameRef.current?.focus({ preventScroll: true });
    focusViaRef.current = null;
  }, []);

  const close = useCallback(() => setPopup(null), []);
  const openAsk = useCallback(() => {
    if (chrome?.askAssistant) chrome.askAssistant(block);
    else setPopup('ask');
  }, [block, chrome]);
  const askLabel = chrome?.askAssistant ? 'Ask assistant' : 'Ask';

  const openEditor = (next: Mode, draft: EditorDraft) => {
    draftRef.current = draft;
    openedRef.current = draftText(draft);
    setMode(next);
  };
  const openEdit = () => {
    if (!chrome || !editable) return;
    const draft: EditorDraft = block.type === 'checklist'
      ? { kind: 'checklist', title: str(block.title), items: checklistItems(block) }
      : block.type === 'callout'
        ? { kind: 'text', text: str(block.text), title: str(block.title) }
        : { kind: 'text', text: str(block.text) };
    openEditor({ kind: 'edit', at: chrome.generatedAt, type: block.type, opened: { id: blockId, fingerprint, words } }, draft);
  };
  const openInsert = (insert: InsertKind) => {
    if (!chrome || mode?.kind === 'edit' || runningRef.current) return;
    setPopup(null);
    if (mode?.kind === 'insert') {
      insertFocusRef.current = true;
      setMode({ ...mode, insert });
      return;
    }
    setInsertHasText(false);
    openEditor({ kind: 'insert', insert, at: chrome.generatedAt, anchor: { id: blockId, fingerprint, words } }, { kind: 'text', text: '' });
  };

  const run = async (ops: MichiPageEditOp[] | null, what: string, at?: number): Promise<ApplyResult | null> => {
    if (!chrome || !ops?.length || runningRef.current) return null;
    runningRef.current = true;
    setBusy(true);
    try {
      return await chrome.apply(ops, what, at);
    } finally {
      runningRef.current = false;
      setBusy(false);
    }
  };

  // After an editor's save: done closes it; anything else keeps it open with the words.
  const settle = (result: ApplyResult | null, viaKeyboard: boolean) => {
    if (result === 'ok') closeEditor(viaKeyboard);
    else if (result === 'stale') setMode((m) => (m ? { ...m, conflict: true } : m));
  };

  /**
   * Saves the edit. Only onto the words the editor opened on, unless the person
   * chose Replace while the block's new words were in front of them.
   */
  const sendEdit = async (draft: EditorDraft, viaKeyboard: boolean, at: number, replace = false) => {
    if (!mode || mode.kind !== 'edit') return;
    if (!replace && !stillSays(mode.opened)) return;
    const changes = draft.kind === 'checklist' ? checklistChanges(block, draft.title, draft.items) : textChanges(block, draft.text, draft.title);
    if (changes === 'empty') {
      chrome?.notice('A checklist needs at least one item', 'info');
      return;
    }
    if (!changes) {
      closeEditor(viaKeyboard);
      return;
    }
    const op = updateOp(block, changes);
    settle(await run(op && [op], 'Page updated', at), viaKeyboard);
  };

  /**
   * Adds the new block under the block it was opened below: this one while it
   * still says what it said then, else wherever those words went. With them
   * gone from the page, the words go to the page's rescue instead.
   */
  const sendInsert = async (insert: InsertKind, text: string, anchor: Opened, viaKeyboard: boolean, at: number) => {
    const markdown = insertMarkdown(insert, text);
    if (!markdown || !blockId || !chrome) {
      closeEditor(viaKeyboard);
      return;
    }
    const after = stillSays(anchor) ? blockId : chrome.findBlock(anchor.fingerprint);
    if (!after) {
      chrome.orphan({ label: INSERT_EDITOR[insert].label, markdown, text });
      closeEditor(viaKeyboard);
      chrome.notice('The block it went under is no longer on the page; your text is kept at the top', 'info');
      return;
    }
    settle(await run([insertOp(after, markdown)], 'Block added', at), viaKeyboard);
  };

  // The same change again, on the page as it is now.
  const reapply = (viaKeyboard: boolean) => {
    if (!mode || !chrome) return;
    const at = chrome.generatedAt;
    const draft = draftRef.current ?? { kind: 'text' as const, text: '' };
    setMode({ ...mode, at, conflict: false });
    if (mode.kind === 'edit') void sendEdit(draft, viaKeyboard, at);
    else void sendInsert(mode.insert, draft.kind === 'text' ? draft.text : draftText(draft), mode.anchor, viaKeyboard, at);
  };
  const copyDraft = () => {
    if (chrome && draftRef.current) chrome.copyText(draftText(draftRef.current), 'your text');
  };
  const changedNote = changed ? <PageChangedNote busy={busy} text={CHANGED_TEXT} onReapply={reapply} onCopy={copyDraft} /> : null;

  // The block changed under the edit: its new words are shown; the person adds theirs below, or replaces on purpose.
  const addBelow = async (viaKeyboard: boolean) => {
    if (!mode || mode.kind !== 'edit' || !chrome || !blockId) return;
    const markdown = draftRef.current ? draftMarkdown(mode.type, draftRef.current) : null;
    if (!markdown) {
      closeEditor(viaKeyboard);
      return;
    }
    settle(await run([insertOp(blockId, markdown)], 'Block added', chrome.generatedAt), viaKeyboard);
  };
  const replace = (viaKeyboard: boolean) => {
    if (!mode || mode.kind !== 'edit' || !chrome || !draftRef.current) return;
    void sendEdit(draftRef.current, viaKeyboard, chrome.generatedAt, true);
  };
  const editNote = rewritten && mode?.kind === 'edit' ? (
    <BlockRewrittenNote
      busy={busy}
      theirs={blockFullText(block)}
      canReplace={block.type === mode.type && isEditableBlock(block)}
      onAddBelow={(viaKeyboard) => { void addBelow(viaKeyboard); }}
      onReplace={replace}
      onCopy={copyDraft}
    />
  ) : changedNote;

  // The next block when there is one, else the one before, so the keyboard stays on the page after a delete.
  const focusNeighbor = () => {
    const frame = frameRef.current;
    const isFrame = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.matches('.michi-doc-block[tabindex]');
    let next: Element | null = frame?.nextElementSibling ?? null;
    while (next && !isFrame(next)) next = next.nextElementSibling;
    let prev: Element | null = frame?.previousElementSibling ?? null;
    while (prev && !isFrame(prev)) prev = prev.previousElementSibling;
    const target = next ?? prev;
    if (isFrame(target)) target.focus({ preventScroll: true });
  };

  const remove = async (viaKeyboard: boolean) => {
    if (!blockId || removed) return;
    const result = await run(deleteOps([blockId]), 'Deleted block');
    if (result !== 'ok') return;
    if (viaKeyboard && frameRef.current?.contains(document.activeElement)) focusNeighbor();
    setRemoved(true);
  };

  const moveBusy = busy || !!chrome?.moving();
  const menuEntries = (): MichiMenuEntry[] => {
    if (!chrome) return [];
    if (chrome.menuEntries) return chrome.menuEntries(block, { ask: openAsk, sources: () => setPopup('sources') });
    const entries: MichiMenuEntry[] = [];
    if (canAsk) entries.push({ id: 'ask', label: askLabel, keys: '/', glyph: <MessageSquare size={14} strokeWidth={1.7} />, onSelect: openAsk });
    if (canBranch) entries.push({ id: 'branch', label: 'Branch from here', glyph: <BranchIcon size={14} />, onSelect: () => chrome.branch(block) });
    if (canAsk || canBranch) entries.push({ divider: true, id: 'd0' });
    if (sourceCount > 0) {
      entries.push({ id: 'sources', label: 'Sources', count: sourceCount, glyph: <DocIcon size={14} />, onSelect: () => setPopup('sources') });
    }
    entries.push({ divider: true, id: 'd1' });
    entries.push({ id: 'copy', label: 'Copy text', glyph: <CopyIcon size={14} />, onSelect: () => chrome.copy([block]) });
    if (blockId && canCopyLink) {
      entries.push({ id: 'link', label: 'Copy link', glyph: <Link2 size={14} strokeWidth={1.7} />, onSelect: () => chrome.copyLink(blockId) });
    }
    if (edited && blockId) {
      entries.push({
        id: 'release',
        label: 'Hand back to agent',
        sub: 'The agent may rewrite it next time',
        glyph: <CornerUpLeft size={14} strokeWidth={1.7} />,
        onSelect: () => { void run([releaseOp(blockId)], 'Handed back to the agent'); },
      });
    }
    if (top && blockId) {
      entries.push(
        {
          id: 'up',
          label: 'Move up',
          glyph: <ArrowUp size={14} strokeWidth={1.7} />,
          disabled: index === 0 || moveBusy,
          onSelect: () => chrome.move(blockId, -1),
        },
        {
          id: 'down',
          label: 'Move down',
          glyph: <ArrowDown size={14} strokeWidth={1.7} />,
          disabled: index >= count - 1 || moveBusy,
          onSelect: () => chrome.move(blockId, 1),
        },
      );
    }
    if (blockId) {
      entries.push({ divider: true, id: 'd2' });
      entries.push({ id: 'delete', label: 'Delete', keys: '⌫', danger: true, disabled: busy, glyph: <TrashIcon size={14} />, onSelect: () => { void remove(false); } });
    }
    return entries;
  };

  const addEntries = (): MichiMenuEntry[] => {
    const entries: MichiMenuEntry[] = [
      { caption: 'Add below', id: 'caption' },
      ...ADD_ITEMS.map((item) => ({ id: item.kind, label: item.label, glyph: item.glyph, onSelect: () => openInsert(item.kind) })),
    ];
    const more = blockId ? chrome?.addEntries?.(blockId, insertTypeRef.current) ?? [] : [];
    if (more.length) entries.push({ divider: true, id: 'more' }, ...more.map(entry => 'onSelect' in entry ? {
      ...entry,
      disabled: entry.disabled || insertHasText,
      title: insertHasText ? 'Add or cancel your text before inserting another block' : entry.title,
      onSelect: () => { closeEditor(false); entry.onSelect(); },
    } : entry));
    return entries;
  };

  const openMenu = (from: 'handle' | 'more') => {
    setMenuFrom(from);
    setPopup('menu');
  };
  const menuAnchor = popup === 'menu' ? (menuFrom === 'more' ? moreRef.current : handleRef.current) : null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!chrome || event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/') {
      event.preventDefault();
      openAsk();
    } else if ((event.key === 'Backspace' || event.key === 'Delete') && blockId && !mode && keyFocusRef.current) {
      event.preventDefault();
      if (!runningRef.current) void remove(true);
    }
  };

  // ⌘/Ctrl-click and Shift-click select the block instead of whatever was under the pointer.
  const onClickCapture = (event: React.MouseEvent) => {
    if (!chrome || !top || !blockId || mode || isTyping(event.target)) return;
    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) return;
    if ((event.target as HTMLElement).closest('.michi-doc-block__margin')) return;
    // Inside a block with clicks of its own (a database picks its rows), the click is its.
    if ((event.target as HTMLElement).closest('[data-michi-interactive]')) return;
    event.preventDefault();
    event.stopPropagation();
    chrome.select(blockId, event.shiftKey ? 'extend' : 'toggle');
  };

  // The toolbar is one tab stop; arrow keys, Home and End move along it.
  const onToolbarKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!TOOLBAR_KEYS.has(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
    const target: EventTarget = event.target;
    const at = buttons.findIndex((b) => b === target);
    if (at < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const n = buttons.length;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + n) % n;
    buttons[next].focus();
    setRove(next);
  };

  // Drawn for the kind of block it opened on, so the words typed survive whatever the block becomes.
  const editor = () => {
    if (!mode || mode.kind !== 'edit') return null;
    if (mode.type === 'checklist') {
      return (
        <ChecklistEditor
          label={`Edit ${label}`}
          title={str(block.title)}
          items={checklistItems(block)}
          busy={busy}
          saveDisabled={changed || rewritten}
          notice={editNote}
          onChange={(title, items) => { draftRef.current = { kind: 'checklist', title, items }; }}
          onCancel={closeEditor}
          onSave={(title, items, viaKeyboard) => { void sendEdit({ kind: 'checklist', title, items }, viaKeyboard, mode.at); }}
        />
      );
    }
    // A callout's title is edited with its words, on its own line above them.
    const callout = mode.type === 'callout';
    return (
      <TextBlockEditor
        label={`Edit ${label}`}
        initial={str(block.text)}
        title={callout ? str(block.title) : undefined}
        multiline={mode.type !== 'heading'}
        maxLength={mode.type === 'heading' ? MICHI_HEADING_MAX : MICHI_TEXT_MAX}
        busy={busy}
        saveDisabled={changed || rewritten}
        notice={editNote}
        onChange={(text, title) => { draftRef.current = callout ? { kind: 'text', text, title } : { kind: 'text', text }; }}
        onCancel={closeEditor}
        onSave={(text, viaKeyboard, title) => {
          void sendEdit(callout ? { kind: 'text', text, title } : { kind: 'text', text }, viaKeyboard, mode.at);
        }}
      />
    );
  };

  useLayoutEffect(() => {
    if (!insertFocusRef.current) return;
    insertFocusRef.current = false;
    frameRef.current?.querySelector<HTMLElement>('.michi-doc-block__insert textarea, .michi-doc-block__insert input')?.focus();
  }, [mode]);

  const insertMode = mode?.kind === 'insert' ? mode : null;
  const insertSpec = insertMode ? INSERT_EDITOR[insertMode.insert] : null;

  // In the margin beside a top-level block; inside a container, where there is no margin, on the toolbar.
  const addButton = (tabIndex?: number) => (
    <button
      ref={addRef}
      type="button"
      className={top ? 'michi-doc-block__add' : 'michi-doc-toolbar__btn'}
      aria-label="Add block below"
      title={editing ? 'Save or cancel your edit before adding a block' : 'Add text below'}
      disabled={editing || busy}
      tabIndex={tabIndex}
      onClick={() => openInsert('text')}
    >
      <PlusIcon size={top ? 13 : 11} />
    </button>
  );

  const toolbar = () => {
    if (!chrome) return null;
    if (chrome.menuEntries) {
      const entries = chrome.menuEntries(block, { ask: openAsk, sources: () => setPopup('sources') })
        .filter((entry): entry is MichiMenuItem => 'onSelect' in entry && ['select', 'ask', 'sources', 'ignore', 'archive'].includes(entry.id));
      const enabled = entries.filter(entry => !entry.disabled);
      return <div className="michi-doc-toolbar michi-doc-toolbar--icons" role="toolbar" aria-label={`Actions for ${label}`} onKeyDown={onToolbarKey} onFocus={event => {
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button:not(:disabled)'));
        const target: EventTarget = event.target;
        const at = buttons.findIndex(button => button === target);
        if (at >= 0) setRove(at);
      }}>
        {entries.map(entry => <HoverTip key={entry.id} label={entry.id === 'ask' ? askLabel : entry.label} delayMs={250}><button
          ref={entry.id === 'ask' ? askRef : entry.id === 'sources' ? sourcesRef : undefined}
          type="button"
          className="michi-doc-toolbar__btn"
          aria-label={entry.id === 'ask' ? askLabel : entry.label}
          aria-pressed={entry.id === 'select' ? selected : undefined}
          aria-haspopup={entry.id === 'sources' || (entry.id === 'ask' && !chrome.askAssistant) ? 'dialog' : undefined}
          aria-expanded={entry.id === 'sources' ? popup === 'sources' : undefined}
          disabled={entry.disabled}
          tabIndex={!entry.disabled && enabled.indexOf(entry) === Math.min(rove, enabled.length - (editable ? 0 : 1)) ? 0 : -1}
          onClick={entry.onSelect}
        >{entry.glyph}</button></HoverTip>)}
        {editable && <><span className="michi-doc-toolbar__sep" aria-hidden="true" /><HoverTip label="Edit" delayMs={250}><button type="button" className="michi-doc-toolbar__btn" aria-label="Edit" tabIndex={rove >= enabled.length ? 0 : -1} onClick={openEdit}><EditIcon size={16} /></button></HoverTip></>}
      </div>;
    }
    // Counted first so the tab stop lands on a button that is there.
    const toolCount = (canAsk ? 1 : 0) + (canBranch ? 1 : 0) + (sourceCount > 0 ? 1 : 0) + (editable ? 1 : 0) + (!top && blockId ? 1 : 0) + 1;
    const tools: React.ReactNode[] = [];
    // Buttons only: the next one's place among them is how many came before it.
    let placed = 0;
    const tab = () => {
      const at = placed;
      placed += 1;
      return at === Math.min(rove, toolCount - 1) ? 0 : -1;
    };
    if (canAsk) tools.push(
      <button
        key="ask"
        ref={askRef}
        type="button"
        className="michi-doc-toolbar__btn"
        aria-haspopup={chrome.askAssistant ? undefined : 'dialog'}
        aria-expanded={chrome.askAssistant ? undefined : popup === 'ask'}
        tabIndex={tab()}
        onClick={() => { if (popup === 'ask') close(); else openAsk(); }}
      >
        {askLabel}
      </button>,
    );
    if (canBranch) tools.push(
      <button key="branch" type="button" className="michi-doc-toolbar__btn" tabIndex={tab()} onClick={() => chrome.branch(block)}>
        <span className="michi-doc-toolbar__glyph" aria-hidden="true"><BranchIcon size={11} /></span>
        Branch
      </button>,
    );
    if (sourceCount > 0) {
      tools.push(
        <button
          key="sources"
          ref={sourcesRef}
          type="button"
          className="michi-doc-toolbar__btn"
          aria-haspopup="dialog"
          aria-expanded={popup === 'sources'}
          tabIndex={tab()}
          onClick={() => setPopup(popup === 'sources' ? null : 'sources')}
        >
          Sources <span className="michi-doc-mono michi-doc-muted">{sourceCount}</span>
        </button>,
      );
    }
    if (editable) {
      tools.push(
        <button key="edit" type="button" className="michi-doc-toolbar__btn" tabIndex={tab()} onClick={openEdit}>
          <EditIcon size={11} />
          Edit
        </button>,
      );
    }
    if (!top && blockId) tools.push(<React.Fragment key="add">{addButton(tab())}</React.Fragment>);
    const moreTab = tab();
    tools.push(<span key="sep" className="michi-doc-toolbar__sep" aria-hidden="true" />);
    tools.push(
      <button
        key="more"
        ref={moreRef}
        type="button"
        className="michi-doc-toolbar__btn"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={popup === 'menu' && menuFrom === 'more'}
        tabIndex={moreTab}
        onClick={() => {
          if (popup === 'menu') close();
          else openMenu('more');
        }}
      >
        ⋯
      </button>,
    );
    return (
      <div
        className="michi-doc-toolbar"
        role="toolbar"
        aria-label={`Actions for ${label}`}
        onKeyDown={onToolbarKey}
        onFocus={(event) => {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button'));
          const target: EventTarget = event.target;
          const at = buttons.findIndex((b) => b === target);
          if (at >= 0 && at !== rove) setRove(at);
        }}
      >
        {tools}
      </div>
    );
  };

  return (
    <div
      ref={frameRef}
      id={id}
      className="michi-doc-block"
      role="group"
      aria-label={label}
      tabIndex={chrome && !removed ? 0 : undefined}
      data-block-id={blockId ?? undefined}
      data-segment-of={segmentOf}
      data-top={top ? '' : undefined}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-removing={removed || undefined}
      data-active={popup ? 'true' : undefined}
      data-editing={editing || undefined}
      data-edited={edited || undefined}
      data-note={note || undefined}
      data-empty={empty || undefined}
      data-nested={!top || undefined}
      onKeyDown={onKeyDown}
      onClickCapture={onClickCapture}
      onPointerDownCapture={() => {
        pressedRef.current = true;
        keyFocusRef.current = false;
      }}
      onFocus={(event) => {
        if (event.target === event.currentTarget) {
          keyFocusRef.current = focusViaRef.current ? focusViaRef.current === 'keyboard' : !pressedRef.current;
        }
        pressedRef.current = false;
      }}
    >
      {chrome && top && !removed && (
        <div
          className="michi-doc-block__margin"
          onPointerDown={(event) => {
            if (event.target !== event.currentTarget || !blockId || (event.button ?? 0) !== 0) return;
            // Dragging down the margin selects blocks, not their text.
            event.preventDefault();
            chrome.marginDown(blockId);
          }}
          onPointerEnter={() => { if (blockId) chrome.marginEnter(blockId); }}
        >
          {blockId && canSelect && (
            <button
              type="button"
              role="checkbox"
              aria-checked={selected}
              aria-label={`Select ${label}`}
              className="michi-doc-block__check"
              onClick={(event) => chrome.select(blockId, event.shiftKey ? 'extend' : 'toggle')}
            >
              {selected && <SquareCheck size={14} strokeWidth={1.8} aria-hidden="true" />}
            </button>
          )}
          {blockId && addButton()}
          <button
            ref={handleRef}
            type="button"
            className="michi-doc-block__handle"
            aria-label="Block menu"
            title={blockId && canDrag ? 'Drag to move, click for the menu' : 'Block menu'}
            aria-haspopup="menu"
            aria-expanded={popup === 'menu' && menuFrom === 'handle'}
            onPointerDown={(event) => {
              if (!canDrag || !blockId || (event.button ?? 0) !== 0) return;
              // A drag moves the block; it must not start a text selection on the way.
              event.preventDefault();
              chrome.dragStart(blockId, event);
            }}
            onClick={() => {
              if (canDrag && chrome.takeDragged()) return;
              if (popup === 'menu') close();
              else openMenu('handle');
            }}
          >
            <GripVertical size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
      )}
      {!editing && !removed && toolbar()}
      {editing ? editor() : note ? (
        <div className="michi-doc-note">
          <div className="michi-doc-caption michi-doc-note__caption">Agent note</div>
          {renderBlock ? renderBlock(block, ctx) : <MichiBlock block={block} ctx={ctx} />}
        </div>
      ) : renderBlock ? renderBlock(block, ctx) : <MichiBlock block={block} ctx={ctx} />}
      {edited && !editing && <span className="michi-doc-edited michi-doc-mono" title={EDITED_HINT}>You edited</span>}
      {renderDecorations?.(block)}
      {insertMode && insertSpec && (
        <div className="michi-doc-block__insert">
          <div className="michi-doc-insert__head">
            <span>{ADD_ITEMS.find(item => item.kind === insertMode.insert)?.label}</span>
            <button ref={insertTypeRef} type="button" className="michi-doc-link-btn" aria-haspopup="menu" aria-expanded={popup === 'add'} disabled={busy}
              onClick={() => setPopup(popup === 'add' ? null : 'add')}>Other blocks</button>
          </div>
          <TextBlockEditor
            label={insertSpec.label}
            initial=""
            placeholder={insertSpec.placeholder}
            multiline={insertSpec.multiline}
            maxLength={insertMode.insert === 'heading' ? MICHI_HEADING_MAX : MICHI_TEXT_MAX}
            measure={insertMode.insert === 'heading' ? undefined : (text) => insertMarkdown(insertMode.insert, text)?.length ?? 0}
            busy={busy}
            saveLabel="Add"
            saveDisabled={changed}
            notice={changedNote}
            onChange={(text) => { draftRef.current = { kind: 'text', text }; setInsertHasText(Boolean(text.trim())); }}
            onCancel={closeEditor}
            onSave={(text, viaKeyboard) => { void sendInsert(insertMode.insert, text, insertMode.anchor, viaKeyboard, insertMode.at); }}
          />
        </div>
      )}

      {chrome && popup === 'ask' && askRef.current && (
        <AskPopover
          anchor={askRef.current}
          label={label}
          suggestions={BLOCK_SUGGESTIONS}
          onClose={close}
          onSubmit={(question) => {
            close();
            chrome.ask(block, question);
          }}
        />
      )}
      {chrome && popup === 'sources' && sourcesRef.current && (
        <SourcesPopover
          anchor={sourcesRef.current}
          label={label}
          count={sourceCount}
          rows={chrome.sources(block)}
          onOpenThread={chrome.openThread}
          onClose={close}
        />
      )}
      {chrome && popup === 'menu' && menuAnchor && (
        <MichiMenu
          anchor={menuAnchor}
          label={`Block menu for ${label}`}
          entries={menuEntries()}
          align={menuFrom === 'more' ? 'end' : 'start'}
          onClose={(restore) => {
            close();
            if (restore) menuAnchor.focus({ preventScroll: true });
          }}
        />
      )}
      {chrome && popup === 'add' && insertTypeRef.current && (
        <MichiMenu
          anchor={insertTypeRef.current}
          label="Add below"
          width={200}
          entries={addEntries()}
          onClose={(restore) => {
            close();
            if (restore) insertTypeRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
});
