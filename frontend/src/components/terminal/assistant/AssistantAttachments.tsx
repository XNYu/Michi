import React, { useState } from 'react';
import type { MichiContextItem } from 'michi-shared';
import { AllThreadsIcon, ChatIcon, DocIcon } from '../icons';
import { attachmentChipLabel, VISIBLE_ATTACHMENTS } from '../../../state/assistant/assistantContext';
import { removeAssistantAttachment, useAssistantComposer } from '../../../state/assistant/assistantComposer';
import './assistant.css';

function KindIcon({ kind }: { kind: MichiContextItem['kind'] }) {
  if (kind === 'block') return <DocIcon size={12} />;
  if (kind === 'row') return <AllThreadsIcon size={12} />;
  return <ChatIcon size={12} />;
}

export function AttachmentChip({ item, onRemove }: { item: MichiContextItem; onRemove: () => void }) {
  const label = attachmentChipLabel(item);
  return (
    <span className="assistant-attach" data-assistant-attachment={item.kind}>
      <span className="assistant-attach__icon" aria-hidden="true"><KindIcon kind={item.kind} /></span>
      <span className="assistant-attach__text" title={label}>{label}</span>
      <button type="button" className="assistant-attach__x" aria-label={`Remove ${label}`} onClick={onRemove}>×</button>
    </span>
  );
}

/**
 * What the user handed the assistant (from a page, a block, a row), as chips
 * above its composer. They go with the next send as quoted material; past
 * three they fold into `+N`.
 */
export function AssistantAttachmentsPreBlock({ nodeId }: { nodeId: string }) {
  const { attachments } = useAssistantComposer(nodeId);
  const [expanded, setExpanded] = useState(false);
  if (attachments.length === 0) return null;
  const visible = expanded ? attachments : attachments.slice(0, VISIBLE_ATTACHMENTS);
  const hidden = attachments.length - visible.length;
  return (
    <div className="assistant-attachments" aria-label="Attached for the assistant">
      {visible.map((item) => (
        <AttachmentChip
          key={`${item.kind}:${item.id}`}
          item={item}
          onRemove={() => removeAssistantAttachment(nodeId, item)}
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="assistant-attach assistant-attach--more"
          aria-label={`Show ${hidden} more`}
          onClick={() => setExpanded(true)}
        >
          +{hidden}
        </button>
      )}
    </div>
  );
}
