import React, { useEffect, useRef, useState } from 'react';
import { Folder, LockKeyhole, MessageSquare, Trash2, Undo2 } from 'lucide-react';
import { ModalShell } from '../../ui/ModalShell';
import { Button } from '../../ui/controls';
import { fetchWorkspace } from '../../../services/api';
import { hydrateBackendWorkspaces } from '../../../state/chatHydration';
import { visibleMessageText } from '../../../state/assistantBlocks';
import type { ChatMessage, ChatNodeState } from '../../../state/chatTypes';
import { entryDeletedAt, entryTitle, plural, remainingDays, type TrashEntry } from './trashModel';
import { TrashIconButton } from './TrashControls';

function ConversationPreview({ node }: { node: ChatNodeState }) {
  const [remote, setRemote] = useState<ChatMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef<{
    key: string;
    controller: AbortController;
    abortTimer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const loaded = node.messagesLoaded === true;
  useEffect(() => {
    if (loaded) return;
    const requestKey = `${node.projectId}:${node.nodeId}:${attempt}`;
    const existing = requestRef.current;
    if (existing?.key === requestKey && !existing.controller.signal.aborted) {
      if (existing.abortTimer !== null) clearTimeout(existing.abortTimer);
      existing.abortTimer = null;
      return () => {
        existing.abortTimer = setTimeout(() => existing.controller.abort(), 0);
      };
    }

    const request = {
      key: requestKey,
      controller: new AbortController(),
      abortTimer: null as ReturnType<typeof setTimeout> | null,
    };
    requestRef.current = request;
    setRemote(null);
    setError(null);
    // Read a detached snapshot: preview never hydrates or writes back to the live store.
    // Delaying cleanup by one task lets React StrictMode's immediate effect replay reuse
    // this request; a real unmount leaves the timer in place and aborts the request.
    void fetchWorkspace(node.projectId, request.controller.signal).then(raw => {
      if (request.controller.signal.aborted || requestRef.current !== request) return;
      const snapshot = hydrateBackendWorkspaces([raw]);
      const match = snapshot.nodes[node.nodeId];
      if (!match || match.projectId !== node.projectId) throw new Error('This thread is no longer available.');
      setRemote(match.messages);
    }).catch((reason: unknown) => {
      if (!request.controller.signal.aborted && requestRef.current === request) {
        setError(reason instanceof Error ? reason.message : 'Could not load conversation.');
      }
    });
    return () => {
      request.abortTimer = setTimeout(() => request.controller.abort(), 0);
    };
  }, [node.projectId, node.nodeId, loaded, attempt]);
  if (error) return <div className="trash-preview-error" role="alert"><p>{error}</p><Button size="sm" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div>;
  const messages = loaded ? node.messages : remote;
  if (!messages) return <div className="trash-preview-loading" role="status" aria-label="Loading conversation"><span /><span /><span /></div>;
  if (!messages.length) return <p className="trash-preview-empty">No messages in this thread.</p>;
  return <>
    {messages.length > 20 && <p className="trash-preview-empty">Latest 20 of {plural(messages.length, 'message')}</p>}
    {messages.slice(-20).map(message => <article className="trash-preview-message" key={message.id}>
      <h4>{message.role === 'user' ? 'You' : 'Assistant'}</h4>
      <p>{visibleMessageText(message) || (message.toolCalls.length ? 'Tool activity' : message.attachments?.length ? 'Attachment' : 'No text content')}</p>
    </article>)}
  </>;
}

export function TrashPreview({ entry, nodes, ttl, now, busy, onClose, onRestore, onDelete, onPreview }: {
  entry: TrashEntry;
  nodes: Record<string, ChatNodeState>;
  ttl: number;
  now: number;
  busy: boolean;
  onClose: () => void;
  onRestore: (entry: TrashEntry) => void;
  onDelete: (entry: TrashEntry) => void;
  onPreview: (entry: TrashEntry) => void;
}) {
  const days = entry.kind === 'thread' ? remainingDays(entry.group, ttl, now) : null;
  const liveTrees = entry.project.trees.filter(tree => !nodes[tree.rootNodeId]?.deletedAt);
  return <ModalShell open onClose={onClose} title="Trash preview" width={570}>
    <div className="trash-preview">
      <div className="trash-preview-scroll term-scrollbar">
        <div className="trash-preview-eyebrow">{entry.kind === 'thread' ? <MessageSquare size={15} aria-hidden="true" /> : <Folder size={15} aria-hidden="true" />}
          {entry.kind === 'thread' ? 'Thread' : 'Workspace'}<span><LockKeyhole size={12} aria-hidden="true" />Read only</span>
        </div>
        <h2>{entryTitle(entry)}</h2>
        <dl>
          <dt>{entry.kind === 'thread' ? 'Workspace' : 'Location'}</dt><dd>{entry.kind === 'thread' ? entry.project.name : entry.project.cwd || 'No folder'}</dd>
          <dt>Deleted</dt><dd>{entryDeletedAt(entry) ? new Date(entryDeletedAt(entry)).toLocaleString() : 'Unknown date'}</dd>
          <dt>Contains</dt><dd>{entry.kind === 'thread' ? plural(entry.group.members.length, 'node') : plural(liveTrees.length + entry.groups.length, 'thread')}</dd>
          {entry.kind === 'thread' && <><dt>Auto-delete</dt><dd className={days !== null && days <= 3 ? 'trash-expiry' : undefined}>{days === null ? 'Off' : days === 0 ? 'Due for deletion' : `In ${plural(days, 'day')}`}</dd></>}
        </dl>
        {entry.kind === 'thread' ? <>
          <h3>Conversation preview <span>{plural(entry.group.root.messagesLoaded === true ? entry.group.root.messages.length : entry.group.root.messageCount ?? entry.group.root.messages.length, 'message')}</span></h3>
          <ConversationPreview key={entry.group.root.nodeId} node={entry.group.root} />
          {entry.group.members.length > 1 && <><h3>Included nodes</h3><ul className="trash-preview-nodes">{entry.group.members.map(node => <li key={node.nodeId}><MessageSquare size={14} aria-hidden="true" /><span>{node.title || 'Untitled node'}</span></li>)}</ul></>}
        </> : <>
          <h3>Threads <span>{liveTrees.length + entry.groups.length}</span></h3>
          <ul className="trash-preview-nodes">
            {liveTrees.map(tree => <li key={tree.id}><MessageSquare size={14} aria-hidden="true" /><span>{tree.name || nodes[tree.rootNodeId]?.title || 'Untitled thread'}</span>{tree.archivedAt && <small>Archived</small>}</li>)}
            {entry.groups.map(group => <li key={group.id}><MessageSquare size={14} aria-hidden="true" /><button type="button" onClick={() => onPreview({ kind: 'thread', project: entry.project, group })}>{group.title}</button><small>In Trash</small></li>)}
          </ul>
          {!liveTrees.length && !entry.groups.length && <p className="trash-preview-empty">No threads in this workspace.</p>}
        </>}
      </div>
      <footer>
        <Button variant="primary" disabled={busy} onClick={() => onRestore(entry)}><Undo2 size={15} aria-hidden="true" />Restore {entry.kind}</Button>
        <TrashIconButton icon={Trash2} tooltip="Delete permanently" aria-label={`Delete ${entryTitle(entry)} permanently`} disabled={busy} onClick={() => onDelete(entry)} className="trash-danger" />
      </footer>
    </div>
  </ModalShell>;
}
