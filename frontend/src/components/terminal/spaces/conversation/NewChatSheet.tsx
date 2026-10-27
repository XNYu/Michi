import React, { Suspense } from 'react';
import { ChevronDown, Folder, GitBranch, MessageSquare, X } from 'lucide-react';
import { useChatProjects } from '../../../../state/chatStore';
import { isSystemWorkspace } from '../../../../state/assistant/systemWorkspace';
import { backendConnectionIdForWorkspace } from '../../../../config/backendConnections';
import {
  closeNewChatSheet,
  requestSpaceConversation,
  setNewChatSheetWorkspace,
  type NewChatSheetState,
  type SpaceConversationScope,
} from '../../../../state/spaceConversations/store';
import { ActionMenu } from '../../../ui/ActionMenu';
import { Button } from '../../../ui/controls';
import { ComposerShell } from '../../ComposerShell';
import type { MentionEditorHandle } from '../../../MentionEditor';
import type { MentionRecord } from '../../../mentions';
import './conversation.css';

const MentionEditor = React.lazy(() => import('../../../MentionEditor'));
const NONE: never[] = [];

/**
 * The sheet "Start a task in [workspace]": one message starts an ordinary
 * conversation on the user's global settings; its progress shows on the page.
 */
export function NewChatSheet({ sheet, scope }: { sheet: NewChatSheetState; scope: SpaceConversationScope }) {
  const { projects, activeProjectId, agentStatus } = useChatProjects();
  const workspaces = React.useMemo(() => projects.filter((project) =>
    backendConnectionIdForWorkspace(project.id) === scope.backendConnectionId
    && !project.archivedAt && !project.deletedAt && !isSystemWorkspace(project)), [projects, scope.backendConnectionId]);
  const chosen = workspaces.find((workspace) => workspace.id === sheet.workspaceId)
    ?? workspaces.find((workspace) => workspace.id === activeProjectId)
    ?? workspaces[0]
    ?? null;
  const [draft, setDraft] = React.useState<{ value: string; mentions: MentionRecord[] }>({ value: sheet.text, mentions: [] });
  const [menuAnchor, setMenuAnchor] = React.useState<HTMLButtonElement | null>(null);
  const editorRef = React.useRef<MentionEditorHandle>(null);
  const sectionRef = React.useRef<HTMLElement>(null);
  const seededSeq = React.useRef(sheet.seq);

  React.useEffect(() => {
    if (seededSeq.current === sheet.seq) return;
    seededSeq.current = sheet.seq;
    setDraft({ value: sheet.text, mentions: [] });
  }, [sheet.seq, sheet.text]);

  React.useEffect(() => {
    // A next step far down the page opens the sheet at the page's top.
    sectionRef.current?.scrollIntoView?.({ block: 'nearest' });
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      if (editorRef.current) { editorRef.current.focus(); return; }
      if (tries++ < 60) timer = window.setTimeout(attempt, 50);
    };
    attempt();
    return () => window.clearTimeout(timer);
  }, [sheet.seq]);

  const text = draft.value.trim();
  const canStart = Boolean(chosen && text && scope.pageId);
  const start = () => {
    if (!chosen || !text || !scope.pageId) return;
    requestSpaceConversation({
      text,
      workspaceId: chosen.id,
      workspaceName: chosen.name,
      backendConnectionId: scope.backendConnectionId,
      startedFromPageId: scope.pageId,
    });
  };

  return (
    <section
      ref={sectionRef}
      className="space-new-chat"
      aria-label="Start a task"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && !menuAnchor) { event.preventDefault(); closeNewChatSheet(); }
      }}
    >
      <ComposerShell
        position="static"
        preBlocks={(
          <div className="space-new-chat__head">
            <MessageSquare size={14} strokeWidth={1.7} aria-hidden="true" />
            <b>Start a task</b>
            <span>in</span>
            <button
              type="button"
              className="space-new-chat__ws"
              aria-haspopup="menu"
              aria-expanded={Boolean(menuAnchor)}
              aria-label={`Workspace: ${chosen?.name ?? 'none'}`}
              disabled={workspaces.length === 0}
              onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget)}
            >
              <Folder size={12} strokeWidth={1.7} aria-hidden="true" />
              <span>{chosen?.name ?? 'No workspace'}</span>
              <ChevronDown size={12} strokeWidth={1.7} aria-hidden="true" />
            </button>
            <span className="space-new-chat__spacer" />
            <button type="button" className="t-icon-btn" aria-label="Close" title="Close (Esc)" onClick={closeNewChatSheet}>
              <X size={14} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </div>
        )}
        input={(
          <Suspense fallback={<div className="composer-loading-stub" />}>
            <MentionEditor
              ref={editorRef}
              value={draft.value}
              mentions={draft.mentions}
              onChange={setDraft}
              className="hide-sb space-new-chat__input"
              data-testid="space-new-chat-input"
              artifacts={NONE}
              sameTreeNodes={NONE}
              currentNodeId="__space_new_chat__"
              enableSlash={false}
              onSubmit={start}
            />
          </Suspense>
        )}
        toolbarLeft={(
          <span className="space-new-chat__runtime">
            <GitBranch size={12} strokeWidth={1.7} aria-hidden="true" />
            {agentStatus?.label ?? 'Default runtime'} · your global settings
          </span>
        )}
        toolbarRight={(
          <>
            <span className="space-new-chat__hint">Follow progress here; the full chat and replies are on the chat page</span>
            <Button variant="primary" size="sm" disabled={!canStart} onClick={start}>Start</Button>
          </>
        )}
      />
      {workspaces.length === 0 && <p className="space-new-chat__error" role="alert">There is no workspace on this backend to start a chat in.</p>}
      {menuAnchor && (
        <ActionMenu
          anchor={menuAnchor}
          label="Start the chat in"
          onClose={() => setMenuAnchor(null)}
          items={workspaces.map((workspace) => ({
            id: workspace.id,
            label: workspace.name,
            icon: <Folder size={12} strokeWidth={1.7} aria-hidden="true" />,
            onSelect: () => { setNewChatSheetWorkspace(workspace.id); editorRef.current?.focus(); },
          }))}
        />
      )}
    </section>
  );
}
