import React, { Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { GripVertical, Maximize2, Minimize2, Minus, PanelRight, PictureInPicture2, Plus, X } from 'lucide-react';
import { HoverTip } from '../../../ui/Popover';
import { kbd } from '../../../../lib/platform';
import type { MetaChatForm, ResizeDir } from '../../../../state/metaChat/metaChatWindowModel';
import { ComposerShell } from '../../ComposerShell';
import { PaneComposerActions } from '../../PaneComposerActions';
import type { MentionEditorHandle } from '../../../MentionEditor';
import type { MentionRecord } from '../../../mentions';
import type { MetaChatSuggestion } from '../../../../state/metaChat/suggestions';

const MentionEditor = React.lazy(() => import('../../../MentionEditor'));

export type { MetaChatSuggestion };

export function MetaChatSuggestions({ suggestions = [], busy, onSuggestion }: Pick<MetaChatContentProps, 'suggestions' | 'busy' | 'onSuggestion'>) {
  return suggestions.length ? <div className="meta-chat-panel__suggestions" role="group" aria-label="Suggested questions">
    {suggestions.map((suggestion, index) => <div key={suggestion.id} className="t-followup-row" data-disabled={busy ? 'true' : undefined} style={{ '--followup-delay': `${index * 90}ms` } as CSSProperties}>
      <button type="button" className="t-followup-text" disabled={busy} title={suggestion.label} onClick={() => onSuggestion?.(suggestion)}>{suggestion.label}</button>
    </div>)}
  </div> : null;
}

export interface MetaChatTarget {
  label: string;
}

export interface MetaChatContentProps {
  /** The page the user is looking at. */
  pageName: string;
  onNewConversation?: () => void;
  newConversationDisabled?: boolean;
  newConversationPending?: boolean;
  conversationKey?: string | null;
  submitDisabled?: boolean;
  /** The Meta agent is working: suggestions are disabled and the pill shows a dot. */
  busy?: boolean;
  /** The block an edit will be limited to. */
  target?: MetaChatTarget | null;
  onClearTarget?: () => void;
  suggestions?: readonly MetaChatSuggestion[];
  onSuggestion?: (suggestion: MetaChatSuggestion) => void;
  onSubmit?: (text: string) => void;
  /** Puts `text` in the input, unsent, each time `id` changes. */
  draftRequest?: { id: number; text: string } | null;
  /** The conversation. A quiet placeholder shows when absent. */
  conversation?: ReactNode;
  /** The live chat owns the shared Michi composer. The standalone input is for previews. */
  conversationComposer?: boolean;
  /** A one-line notice above the suggestions (e.g. the Meta agent stopped). */
  notice?: ReactNode;
}

const RESIZE_DIRS: readonly ResizeDir[] = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];
export const MINIMIZE_KEYS = kbd('mod', 'J');
const EMPTY_DRAFT = { value: '', mentions: [] as MentionRecord[] };
const NONE: never[] = [];
const noop = () => {};

interface MetaChatPanelProps extends MetaChatContentProps {
  form: MetaChatForm | 'full';
  hidden: boolean;
  style?: CSSProperties;
  focusToken: number;
  sizeLabel: string | null;
  onTitlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onResizePointerDown: (dir: ResizeDir, event: ReactPointerEvent<HTMLElement>) => void;
  /** Absent where the window has no half screen (a phone). */
  onToggleDock?: () => void;
  onMinimize: () => void;
  onToggleFullscreen: () => void;
}

export function MetaChatPanel({
  form,
  hidden,
  style,
  focusToken,
  sizeLabel,
  onTitlePointerDown,
  onResizePointerDown,
  onToggleDock,
  onMinimize,
  onToggleFullscreen,
  onNewConversation,
  newConversationDisabled,
  newConversationPending,
  conversationKey,
  submitDisabled,
  pageName,
  busy = false,
  target,
  onClearTarget,
  suggestions = [],
  onSuggestion,
  onSubmit,
  draftRequest,
  conversation,
  conversationComposer = false,
  notice,
}: MetaChatPanelProps) {
  const floating = form === 'float';
  const editorRef = useRef<MentionEditorHandle>(null);
  const seenFocus = useRef(focusToken);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const seenDraft = useRef<number | null>(null);
  // Keep each conversation's unsent text when switching; resizing never remounts the input.
  const drafts = useRef(new Map<string | null | undefined, typeof EMPTY_DRAFT>());
  const [draftKey, setDraftKey] = useState(conversationKey);
  if (draftKey !== conversationKey) {
    drafts.current.set(draftKey, draft);
    setDraftKey(conversationKey);
    setDraft(drafts.current.get(conversationKey) ?? EMPTY_DRAFT);
  }

  useEffect(() => {
    if (!draftRequest || draftRequest.id === seenDraft.current) return;
    seenDraft.current = draftRequest.id;
    setDraft({ value: draftRequest.text, mentions: [] });
  }, [draftRequest]);

  useEffect(() => {
    if (focusToken === seenFocus.current) return;
    seenFocus.current = focusToken;
    editorRef.current?.focus();
  }, [focusToken]);

  const submit = useCallback(() => {
    const text = draft.value.trim();
    if (!text || submitDisabled) return;
    onSubmit?.(text);
    setDraft(EMPTY_DRAFT);
  }, [draft.value, onSubmit, submitDisabled]);

  return (
    <section
      className="meta-chat-panel"
      data-form={form}
      aria-label="Assistant"
      hidden={hidden}
      style={style}
    >
      <header
        className="meta-chat-panel__title"
        onPointerDown={floating ? onTitlePointerDown : undefined}
      >
        {floating ? <GripVertical className="meta-chat-panel__grip" size={13} aria-hidden /> : null}
        <b className="meta-chat-panel__name">Assistant</b>
        <span className="meta-chat-panel__viewing" title={`Viewing: ${pageName}`}>
          <span className="meta-chat-panel__viewing-prefix">Viewing: </span>{pageName}
        </span>
        {onNewConversation && <HoverTip label="New conversation">
          <button type="button" className="t-icon-btn meta-chat-panel__new" aria-label="New conversation" aria-busy={newConversationPending || undefined} disabled={newConversationDisabled || newConversationPending} onClick={onNewConversation}>
            <Plus size={16} aria-hidden /><span>New conversation</span>
          </button>
        </HoverTip>}
        <HoverTip label={form === 'full' ? 'Exit full screen' : 'Full screen'}>
          <button type="button" className="t-icon-btn" aria-label={form === 'full' ? 'Exit full screen' : 'Full screen'} onClick={onToggleFullscreen}>
            {form === 'full' ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
          </button>
        </HoverTip>
        {onToggleDock && <HoverTip label={floating ? 'Dock as half screen' : 'Back to floating'}>
          <button
            type="button"
            className="t-icon-btn"
            aria-label={floating ? 'Dock as half screen' : 'Back to floating'}
            onClick={onToggleDock}
          >
            {floating ? <PanelRight size={15} aria-hidden /> : <PictureInPicture2 size={15} aria-hidden />}
          </button>
        </HoverTip>}
        <HoverTip label="Minimize" kbd={MINIMIZE_KEYS}>
          <button type="button" className="t-icon-btn" aria-label="Minimize" onClick={onMinimize}>
            <Minus size={15} aria-hidden />
          </button>
        </HoverTip>
      </header>

      <div className="meta-chat-panel__log">
        {conversation ?? <p className="meta-chat-panel__empty">Ask about this page, any workspace or any conversation.</p>}
      </div>

      {notice}

      <MetaChatSuggestions suggestions={suggestions} busy={busy} onSuggestion={onSuggestion} />

      {!conversationComposer && <div className="meta-chat-panel__input">
        <ComposerShell
          position="static"
          preBlocks={target ? (
            <span className="meta-chat-panel__target">
              Targeting: {target.label}
              <button type="button" aria-label="Clear target" onClick={onClearTarget}>
                <X size={11} aria-hidden />
              </button>
            </span>
          ) : undefined}
          input={
            <Suspense fallback={<div className="composer-loading-stub" />}>
              <MentionEditor
                ref={editorRef}
                value={draft.value}
                mentions={draft.mentions}
                onChange={setDraft}
                className="hide-sb"
                data-testid="meta-chat-input"
                artifacts={NONE}
                sameTreeNodes={NONE}
                currentNodeId="__meta_chat__"
                enableSlash={false}
                onSubmit={submit}
              />
            </Suspense>
          }
          toolbarRight={
            <PaneComposerActions
              draftHasText={false}
              sendMode="send"
              streaming={false}
              sendDisabled={submitDisabled || !draft.value.trim()}
              onBranch={noop}
              onSend={submit}
              onStop={noop}
              onRetry={noop}
            />
          }
        />
      </div>}

      {floating
        ? RESIZE_DIRS.map((dir) => (
          <i
            key={dir}
            className={`meta-chat-panel__resize meta-chat-panel__resize--${dir}`}
            data-dir={dir}
            aria-hidden
            onPointerDown={(e) => onResizePointerDown(dir, e)}
          />
        ))
        : null}
      {sizeLabel ? <span className="meta-chat-panel__size">{sizeLabel}</span> : null}
    </section>
  );
}
