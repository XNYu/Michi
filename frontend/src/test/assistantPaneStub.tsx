import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { requestAssistantSend } from '../state/assistant/assistantComposer';

// TPane stores drafts on the chat node, outside the mounted pane.
const drafts = new Map<string, string>();
export function resetAssistantPaneStubDrafts() { drafts.clear(); }

/** The pane/composer boundary for tests of the surrounding Spaces navigation and targeting. */
export default function AssistantPaneStub({
  nodeId, composerPreBlocks, composerFocusToken, draftRequest, composerDisabled,
}: {
  nodeId: string;
  composerPreBlocks?: ReactNode | ((draftHasText: boolean) => ReactNode);
  composerFocusToken?: number;
  draftRequest?: { id: number; text: string } | null;
  composerDisabled?: boolean;
}) {
  const [draft, updateDraft] = useState(() => drafts.get(nodeId) ?? '');
  const setDraft = (value: string) => { drafts.set(nodeId, value); updateDraft(value); };
  const input = useRef<HTMLTextAreaElement>(null);
  const seenFocus = useRef(composerFocusToken);
  useEffect(() => {
    if (draftRequest) setDraft(draftRequest.text);
  }, [draftRequest]);
  useEffect(() => {
    if (seenFocus.current === composerFocusToken) return;
    seenFocus.current = composerFocusToken;
    input.current?.focus();
  }, [composerFocusToken]);
  return <>
    {typeof composerPreBlocks === 'function' ? composerPreBlocks(Boolean(draft.trim())) : composerPreBlocks}
    <textarea ref={input} aria-label="Message the assistant" disabled={composerDisabled}
      value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || composerDisabled || !draft.trim()) return;
        event.preventDefault();
        requestAssistantSend(nodeId, draft);
        setDraft('');
      }} />
  </>;
}
