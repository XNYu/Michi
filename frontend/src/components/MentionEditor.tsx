import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Mention from '@tiptap/extension-mention';
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion';
import { exitSuggestion } from '@tiptap/suggestion';
import type { EditorState } from '@tiptap/pm/state';
import type { ArtifactEntry, ChatNodeState } from '../state/chatStore';
import type { AgentCommand, SessionMode } from '../services/api';
import type { MentionRecord } from './mentions';
import { buildAtMentionItems, type AtMentionItem } from './mentionItems';
import {
  matchSlashContext,
  buildSlashItems,
  buildAgentItems,
  type SlashItem,
} from './slashItems';
import { PopoverSurface, MenuItem } from './ui/Popover';
import { useMenuConfirm } from './ui/useMenuConfirm';
import { docToDraft, draftToDoc } from './mentionDoc';
import { ChatIcon, DocIcon, FileIcon, ImageIcon, LinkIcon } from './terminal/icons';

/** Line glyph for a mention row: chat bubble for nodes, per-type icon for artifacts. */
function MentionGlyph({ item }: { item: AtMentionItem }) {
  if (item.kind === 'node') return <ChatIcon />;
  switch (item.artifactType) {
    case 'file': return <FileIcon />;
    case 'image': return <ImageIcon />;
    case 'link': return <LinkIcon />;
    default: return <DocIcon />;
  }
}

/**
 * TipTap-backed replacement for MentionTextarea. Presents the SAME controlled
 * `{ value, mentions }` contract (so the store / submit / queue / expandMentions
 * are untouched) but renders an atomic-mention contenteditable instead of a
 * transparent-textarea + overlay. Owns BOTH composer popups that used to be
 * textarea-coupled siblings: @-mention (AtMentionPopup) and /-command (SlashPopup).
 */

export interface MentionEditorHandle {
  focus: () => void;
  /** Underlying TipTap editor, for callers that need imperative access. */
  editor: Editor | null;
}

export interface MentionEditorProps {
  value: string;
  mentions: MentionRecord[];
  onChange: (next: { value: string; mentions: MentionRecord[] }) => void;
  disabled?: boolean;
  className?: string;
  'data-testid'?: string;

  /** @-mention suggestion data source (was AtMentionPopup's props). */
  artifacts: ArtifactEntry[];
  sameTreeNodes: ChatNodeState[];
  currentNodeId: string;
  /** Nodes from other threads in the same workspace, grouped by thread title. */
  crossTreeNodes?: import('./mentionItems').CrossTreeGroup[];

  /** /-command data sources (were SlashPopup's props). */
  agentCommands?: AgentCommand[];
  availableModes?: SessionMode[];
  currentModeId?: string | null;
  onSwitchAgent?: (modeId: string) => void;
  /** Enable `/`-command autocomplete (TPane: yes; ManageComposer: no). Default true. */
  enableSlash?: boolean;

  /** Enter (no Shift) always submits; `branch` is true for Mod+Enter. Replaces TPane's onKeyDown. */
  onSubmit?: (opts: { branch: boolean }) => void;
  /** Native paste passthrough (image paste handling lives in the host). */
  onPaste?: (e: ClipboardEvent) => void;
}

// The composer's StarterKit subset. Inline marks AND block nodes (heading,
// lists, blockquote, codeBlock) are enabled: input rules consume the typed
// markdown syntax (`**bold**` → bold mark, `- ` → list item), and docToDraft
// re-emits the equivalent markdown on serialize, so the submitted value keeps
// what the user typed while the composer renders it WYSIWYG.
// horizontalRule stays off (nobody types `---` in chat; easy to mistrigger).
// trailingNode stays off: it auto-appends an empty paragraph after a trailing
// code block / list, which would leak a spurious `\n` into the wire value —
// codeBlock's exitOnArrowDown covers the escape path (plain Enter submits, so
// exitOnTripleEnter never fires; newlines inside the fence come from Shift+Enter).
// Exported so tests can drive a real editor with the exact production config.
export const composerStarterKit = StarterKit.configure({
  horizontalRule: false,
  trailingNode: false,
  // Don't open links on a plain click — the composer is an editing surface, so a
  // bare click should place the caret, not navigate away. Cmd/Ctrl+click opens
  // (see the click handler in editorProps.handleDOMEvents).
  link: { openOnClick: false },
});

/**
 * Whether the selection sits inside a formatted block (code block, list item,
 * blockquote, heading). Plain Enter ALWAYS submits — chat convention — but
 * Shift+Enter inside one of these runs the block-native Enter instead of the
 * default hardBreak: next list item, newline in code, new paragraph in a
 * quote, body paragraph after a heading.
 */
export function enterContinuesBlock(state: EditorState): boolean {
  const { $from } = state.selection;
  if ($from.parent.type.name === 'heading') return true;
  for (let d = $from.depth; d > 0; d -= 1) {
    const name = $from.node(d).type.name;
    if (name === 'codeBlock' || name === 'listItem' || name === 'blockquote') return true;
  }
  return false;
}

// Mention node extended to carry our MentionRecord fields (refId + kind) on top
// of the default label. Defaults render a `<span class="mention-chip">@label</span>`.
const MentionNode = Mention.extend({
  addAttributes() {
    return {
      refId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-ref-id'),
        renderHTML: (attrs) => (attrs.refId ? { 'data-ref-id': attrs.refId } : {}),
      },
      label: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (attrs) => (attrs.label ? { 'data-label': attrs.label } : {}),
      },
      kind: {
        default: 'context',
        parseHTML: (el) => el.getAttribute('data-kind') || 'context',
        renderHTML: (attrs) => ({ 'data-kind': attrs.kind }),
      },
    };
  },
});

const serialize = (value: string, mentions: MentionRecord[]) =>
  JSON.stringify({ value, mentions });

// ---- @-mention suggestion popup (replaces AtMentionPopup's list rendering).

type PopupState = {
  items: AtMentionItem[];
  command: (item: AtMentionItem) => void;
  rect: DOMRect | null;
};

function SuggestionPopup({
  state,
  selected,
  anchor,
  onHover,
  onPick,
  blinkingId,
}: {
  state: PopupState | null;
  selected: number;
  anchor: HTMLElement | null;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
  blinkingId: string | null;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  if (!state || state.items.length === 0) return null;
  const { items, rect } = state;
  // Horizontal: anchor at the @ caret (the suggestion decoration's rect),
  // clamped so a near-right-edge @ doesn't push the popup off-screen.
  // Vertical: above the composer card (same as the slash popup), via the host.
  // PopoverSurface portals to <body>, so a transformed composer ancestor can't
  // hijack the position:fixed containing block (the bug a plain inline div hit).
  const POPUP_MAX = 420;
  const hostRect = anchor?.getBoundingClientRect();
  const caretLeft = rect ? rect.left : hostRect?.left ?? 0;
  const left = Math.max(8, Math.min(caretLeft, window.innerWidth - POPUP_MAX - 8));
  const anchorTop = hostRect ? hostRect.top : rect ? rect.top : window.innerHeight;
  return (
    <PopoverSurface
      menuKind="mentions"
      className="michi-menu-autocomplete"
      left={left}
      bottom={window.innerHeight - anchorTop + 6}
      minWidth="min(280px, calc(100vw - 16px))"
      maxWidth={`min(${POPUP_MAX}px, calc(100vw - 16px))`}
      maxHeight={`max(80px, ${anchorTop - 14}px)`}
      zIndex={60}
      role="listbox"
      aria-label="Mentions"
      style={{ overflow: 'hidden' }}
    >
      <ul ref={listRef} className="michi-menu-list">
        {items.map((it, i) => (
          <MenuItem
            key={it.id}
            role="option"
            className={blinkingId === `mention-${it.id}` ? 'ui-menu-blink' : undefined}
            active={i === selected}
            aria-selected={i === selected}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
          >
            <span className="michi-menu-glyph" aria-hidden="true"><MentionGlyph item={it} /></span>
            <span className="michi-menu-label">
              {it.label}
            </span>
            {it.description && (
              <span className="michi-menu-badge">
                {it.description}
              </span>
            )}
          </MenuItem>
        ))}
      </ul>
      <div className="michi-menu-footer">
        ↑↓ navigate · ↵/⇥ accept · esc cancel
      </div>
    </PopoverSurface>
  );
}

// ---- /-command popup (replaces SlashPopup's list rendering; same look/feel).

function SlashCommandPopup({
  items,
  selected,
  anchor,
  onHover,
  onPick,
  blinkingId,
}: {
  items: SlashItem[];
  selected: number;
  anchor: HTMLElement | null;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
  blinkingId: string | null;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  if (items.length === 0 || !anchor) return null;
  const rect = anchor.getBoundingClientRect();
  return (
    <PopoverSurface
      menuKind="slash"
      className="michi-menu-autocomplete"
      left={Math.max(8, Math.min(rect.left, window.innerWidth - 488))}
      bottom={window.innerHeight - rect.top + 6}
      minWidth={`min(${Math.max(320, Math.min(420, rect.width))}px, calc(100vw - 16px))`}
      maxWidth="min(480px, calc(100vw - 16px))"
      maxHeight={`max(80px, ${rect.top - 14}px)`}
      zIndex={60}
      role="listbox"
      aria-label="Slash commands"
      style={{ overflow: 'hidden' }}
    >
      <ul ref={listRef} className="michi-menu-list">
        {items.map((it, i) => (
          <MenuItem
            key={`${it.source}-${it.name}`}
            role="option"
            className={blinkingId === `slash-${it.source}-${it.name}` ? 'ui-menu-blink' : undefined}
            active={i === selected}
            aria-selected={i === selected}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(i);
            }}
          >
            <span className="michi-menu-command">/{it.name}</span>
            {it.description && (
              <span className="michi-menu-label michi-menu-caption">
                {it.description}
              </span>
            )}
            {it.source !== 'agent' && (
              <span className="michi-menu-badge">
                {it.source}
              </span>
            )}
          </MenuItem>
        ))}
      </ul>
      <div className="michi-menu-footer">
        ↑↓ navigate · ↵/⇥ accept · esc cancel
      </div>
    </PopoverSurface>
  );
}

const MentionEditor = forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditor(
  props,
  ref,
) {
  const {
    value,
    mentions,
    onChange,
    disabled,
    className,
    artifacts,
    sameTreeNodes,
    currentNodeId,
    crossTreeNodes,
    agentCommands,
    availableModes,
    currentModeId,
    onSwitchAgent,
    enableSlash = true,
    onSubmit,
    onPaste,
  } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  // Editor handle for the (mount-time) handleKeyDown closure — the Shift+Enter
  // path needs editor.commands, but `editor` doesn't exist when useEditor's
  // config object is built. Assigned right after useEditor returns.
  const editorRef = useRef<Editor | null>(null);

  // Refs the (mount-time) ProseMirror plugin callbacks read for fresh values.
  const contextsRef = useRef(artifacts);
  const nodesRef = useRef(sameTreeNodes);
  const crossTreeNodesRef = useRef(crossTreeNodes);
  const currentNodeIdRef = useRef(currentNodeId);
  const onSubmitRef = useRef(onSubmit);
  const onPasteRef = useRef(onPaste);
  const onSwitchAgentRef = useRef(onSwitchAgent);
  contextsRef.current = artifacts;
  nodesRef.current = sameTreeNodes;
  crossTreeNodesRef.current = crossTreeNodes;
  currentNodeIdRef.current = currentNodeId;
  onSubmitRef.current = onSubmit;
  onPasteRef.current = onPaste;
  onSwitchAgentRef.current = onSwitchAgent;

  // The last (value, mentions) WE produced or applied — used to distinguish an
  // echo of our own onChange (skip) from a genuine external change (re-sync).
  const lastSyncedRef = useRef(serialize(value, mentions));

  const [popup, setPopup] = useState<PopupState | null>(null);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  const popupRef = useRef<PopupState | null>(null);
  const suggestionOpenRef = useRef(false);
  const { blinkingId, confirm, cancel: cancelConfirmation } = useMenuConfirm();
  selectedRef.current = selected;
  popupRef.current = popup;
  const acceptMentionRef = useRef<(index: number) => void>(() => {});
  acceptMentionRef.current = (index) => {
    const current = popupRef.current;
    const item = current?.items[index];
    if (current && item) confirm(`mention-${item.id}`, () => current.command(item));
  };

  // ---- /-command state. Driven by the editor's value + caret (not a textarea).
  const [slashCtx, setSlashCtx] = useState<{ query: string; command?: string } | null>(null);
  const [slashSelected, setSlashSelected] = useState(0);
  const slashItems = useMemo<SlashItem[]>(() => {
    if (!enableSlash || !slashCtx) return [];
    if (slashCtx.command === 'agent') return buildAgentItems(availableModes, currentModeId, slashCtx.query);
    return buildSlashItems(agentCommands, slashCtx.query);
  }, [enableSlash, slashCtx, agentCommands, availableModes, currentModeId]);
  const slashItemsRef = useRef<SlashItem[]>([]);
  const slashSelectedRef = useRef(0);
  const slashOpenRef = useRef(false);
  slashItemsRef.current = slashItems;
  slashSelectedRef.current = slashSelected;
  slashOpenRef.current = !!slashCtx && slashItems.length > 0;

  // Imperative slash actions, rebound when `editor` becomes available so the
  // editor-creation keymap closure can reach them via refs.
  const acceptSlashRef = useRef<(idx: number) => void>(() => {});
  const escapeSlashRef = useRef<() => void>(() => {});

  // Memoize the extensions array so TipTap doesn't diff/setOptions() every render.
  // All dynamic data inside suggestion callbacks is accessed via refs, so [] deps is safe.
  const extensions = useMemo(
    () => [
      composerStarterKit,
      MentionNode.configure({
        HTMLAttributes: { class: 'mention-chip' },
        renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.refId ?? ''}`,
        suggestion: {
          char: '@',
          items: ({ query }) =>
            buildAtMentionItems(query, contextsRef.current, nodesRef.current, currentNodeIdRef.current, crossTreeNodesRef.current),
          command: ({ editor: ed, range, props: picked }) => {
            const item = picked as unknown as AtMentionItem;
            const refId = item.kind === 'context' ? item.token : item.token.replace(/^node:/, '');
            ed
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: 'mention', attrs: { refId, label: item.label, kind: item.kind } },
                { type: 'text', text: ' ' },
              ])
              .run();
          },
          render: () => ({
            onStart: (sp: SuggestionProps) => {
              cancelConfirmation();
              suggestionOpenRef.current = true;
              setSelected(0);
              setPopup({
                items: sp.items as AtMentionItem[],
                command: (it: AtMentionItem) => sp.command(it as unknown as Record<string, unknown>),
                rect: sp.clientRect?.() ?? null,
              });
            },
            onUpdate: (sp: SuggestionProps) => {
              cancelConfirmation();
              setSelected(0);
              setPopup({
                items: sp.items as AtMentionItem[],
                command: (it: AtMentionItem) => sp.command(it as unknown as Record<string, unknown>),
                rect: sp.clientRect?.() ?? null,
              });
            },
            onKeyDown: (sp: SuggestionKeyDownProps): boolean => {
              const cur = popupRef.current;
              if (!cur || cur.items.length === 0) return false;
              const n = cur.items.length;
              if (sp.event.key === 'ArrowDown') {
                cancelConfirmation();
                setSelected((i) => (i + 1) % n);
                return true;
              }
              if (sp.event.key === 'ArrowUp') {
                cancelConfirmation();
                setSelected((i) => (i - 1 + n) % n);
                return true;
              }
              if (sp.event.key === 'Enter' || sp.event.key === 'Tab') {
                if (sp.view.composing || sp.event.isComposing) return false;
                acceptMentionRef.current(selectedRef.current);
                return true;
              }
              if (sp.event.key === 'Escape') {
                cancelConfirmation();
                exitSuggestion(sp.view);
                return true;
              }
              return false;
            },
            onExit: () => {
              cancelConfirmation();
              suggestionOpenRef.current = false;
              setPopup(null);
            },
          }),
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const editor = useEditor({
    extensions,
    content: draftToDoc(value, mentions),
    editable: !disabled,
    editorProps: {
      handleKeyDown: (view, event) => {
        // The @-mention suggestion owns navigation/accept keys while open.
        if (suggestionOpenRef.current) return false;

        // The /-command popup owns ↑↓/Enter/Tab/Esc while open.
        if (slashOpenRef.current) {
          const n = slashItemsRef.current.length;
          if (event.key === 'ArrowDown') {
            cancelConfirmation();
            setSlashSelected((s) => (s + 1) % n);
            return true;
          }
          if (event.key === 'ArrowUp') {
            cancelConfirmation();
            setSlashSelected((s) => (s - 1 + n) % n);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            if (view.composing || event.isComposing) return false;
            event.preventDefault();
            acceptSlashRef.current(slashSelectedRef.current);
            return true;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            escapeSlashRef.current();
            return true;
          }
        }

        if (event.key === 'Enter') {
          // IME guard: never submit mid-composition (matches the old textarea path).
          if (view.composing || event.isComposing) return false;
          if (event.shiftKey) {
            // Shift+Enter inside a formatted block runs the block-native Enter
            // (next list item, newline in code, new paragraph in a quote) so
            // markdown drafting can continue; in a plain paragraph fall
            // through to the default hardBreak soft newline.
            if (!enterContinuesBlock(view.state)) return false;
            const ed = editorRef.current;
            if (!ed) return false;
            event.preventDefault();
            return ed.commands.first(({ commands }) => [
              () => commands.newlineInCode(),
              () => commands.splitListItem('listItem'),
              () => commands.createParagraphNear(),
              () => commands.liftEmptyBlock(),
              () => commands.splitBlock(),
            ]);
          }
          const branch = event.metaKey || event.ctrlKey;
          event.preventDefault();
          onSubmitRef.current?.({ branch });
          return true;
        }
        return false;
      },
      handleDOMEvents: {
        paste: (_view, event) => {
          onPasteRef.current?.(event as ClipboardEvent);
          // If the host handler called preventDefault (e.g. long-text→file),
          // tell ProseMirror to skip its default text insertion.
          return event.defaultPrevented;
        },
        // openOnClick is off (links are editable text); Cmd/Ctrl+click opens.
        click: (_view, event) => {
          if (!(event.metaKey || event.ctrlKey)) return false;
          const anchor = (event.target as HTMLElement | null)?.closest('a[href]');
          const href = anchor?.getAttribute('href');
          if (!href) return false;
          event.preventDefault();
          window.open(href, '_blank', 'noopener,noreferrer');
          return true;
        },
      },
    },
    onUpdate: ({ editor: ed }) => {
      const draft = docToDraft(ed.getJSON() as Parameters<typeof docToDraft>[0]);
      lastSyncedRef.current = serialize(draft.value, draft.mentions);
      onChange(draft);
      // hardBreak at the bottom of the scroll window doesn't auto-scroll; assert
      // it next frame. Guard isDestroyed: the editor may unmount between this
      // edit and the rAF (e.g. submit clears + the pane closes, fast nav).
      requestAnimationFrame(() => {
        if (!ed.isDestroyed) ed.commands.scrollIntoView();
      });
    },
  });
  editorRef.current = editor ?? null;

  // External → editor: re-sync only when the incoming props differ from what we
  // last emitted/applied (draft restore, clear-on-send, history redo). Guard
  // prevents the onChange → setState → props → setContent feedback loop.
  useEffect(() => {
    if (!editor) return;
    const incoming = serialize(value, mentions);
    if (incoming === lastSyncedRef.current) return;
    lastSyncedRef.current = incoming;
    editor.commands.setContent(draftToDoc(value, mentions), { emitUpdate: false });
  }, [editor, value, mentions]);

  useEffect(() => {
    if (disabled) cancelConfirmation();
    editor?.setEditable(!disabled);
  }, [editor, disabled, cancelConfirmation]);

  // Recompute /-command context from the editor's text + caret on every doc or
  // selection change. The caret's TEXT offset is derived with the same leaf
  // serialization docToDraft uses (mention → `@label`, hardBreak → `\n`) so it
  // lines up with `value`.
  useEffect(() => {
    if (!editor) return;
    const recompute = () => {
      cancelConfirmation();
      const v = docToDraft(editor.getJSON() as Parameters<typeof docToDraft>[0]).value;
      const before = editor.state.doc.textBetween(0, editor.state.selection.from, '\n', (node) =>
        node.type.name === 'mention'
          ? `@${node.attrs.label ?? node.attrs.refId ?? ''}`
          : node.type.name === 'hardBreak'
            ? '\n'
            : '',
      );
      setSlashCtx(matchSlashContext(v, before.length));
      setSlashSelected(0);
    };
    editor.on('update', recompute);
    editor.on('selectionUpdate', recompute);
    const blur = () => {
      cancelConfirmation();
      exitSuggestion(editor.view);
      setSlashCtx(null);
    };
    editor.on('blur', blur);
    recompute();
    return () => {
      editor.off('update', recompute);
      editor.off('selectionUpdate', recompute);
      editor.off('blur', blur);
    };
  }, [editor, cancelConfirmation]);

  // Bind slash actions once the editor exists.
  useEffect(() => {
    acceptSlashRef.current = (idx: number) => {
      const it = slashItemsRef.current[idx];
      if (!it || !editor) return;
      confirm(`slash-${it.source}-${it.name}`, () => {
        // Agent picker: invoke the switch and clear the composer.
        if (it.source === 'agent' && it.modeId) {
          onSwitchAgentRef.current?.(it.modeId);
          editor.commands.clearContent();
          editor.commands.focus('end');
          return;
        }
        // Replace the whole composer with `/<name> ` (slash is always at start).
        const text = `/${it.name}${it.takesArgs ? ' ' : ''}`;
        editor.commands.setContent(draftToDoc(text, []));
        editor.commands.focus('end');
      });
    };
    escapeSlashRef.current = () => {
      cancelConfirmation();
      editor?.commands.clearContent();
      editor?.commands.focus();
    };
  }, [editor, confirm, cancelConfirmation]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => editor?.commands.focus(),
      editor: editor ?? null,
    }),
    [editor],
  );

  return (
    <div ref={hostRef} style={{ position: 'relative', flex: 1, minWidth: 0 }} className="mention-editor-host">
      <EditorContent editor={editor} className={className} data-testid={props['data-testid']} />
      <SuggestionPopup state={popup} selected={selected} anchor={hostRef.current} onHover={setSelected}
        onPick={(i) => acceptMentionRef.current(i)} blinkingId={blinkingId} />
      <SlashCommandPopup
        items={slashItems}
        selected={slashSelected}
        anchor={hostRef.current}
        onHover={setSlashSelected}
        onPick={(i) => acceptSlashRef.current(i)}
        blinkingId={blinkingId}
      />
    </div>
  );
});

export default MentionEditor;
