import React from 'react';
import MarkdownContent from '../../MarkdownContent';
import { userTextToMarkdown } from '../../terminal/MessageBlock';
import type { ChatMessage } from '../../../state/chatTypes';
import ToolChip from './ToolChip';
import { useLongPress } from '../hooks/useLongPress';
import { useVisibleStream } from '../../../state/streamingProjection';

interface Props {
  message: ChatMessage;
  onLongPress?: (msg: ChatMessage) => void;
  highlightTerm?: string | null;
  runtimeId?: string | null;
}

/**
 * Single message in the chat stream. User messages right-aligned with a tinted
 * background; bot messages full-width with no background. Bot messages support
 * long-press (450ms) to open the action sheet.
 *
 * Assistant rendering goes through useVisibleStream: raw m.text → strip
 * sentinels → smooth → weave tools into markdown-safe positions, returning
 * segments mixing text and tool-group chips. User messages bypass the hook
 * (no sentinels, no tool calls) and render m.text directly.
 */
export default function MobileMessage({ message, onLongPress, highlightTerm, runtimeId }: Props) {
  const longPress = useLongPress<HTMLDivElement>({
    enabled: message.role === 'assistant' && !!onLongPress,
    onLongPress: () => onLongPress?.(message),
    durationMs: 450,
  });

  const isUser = message.role === 'user';
  const { segments } = useVisibleStream(message, runtimeId);

  return (
    <div className="m-msg" data-role={message.role} {...longPress.handlers}>
      <span className="m-msg-label">{isUser ? 'YOU' : 'KIRO'}</span>
      <div className="m-msg-body">
        {message.thought && <ThoughtBlock text={message.thought} />}
        {isUser ? (
          // userTextToMarkdown keeps the user's literal line breaks (markdown
          // would collapse single \n into a space).
          <MarkdownContent text={userTextToMarkdown(message.text)} highlightTerm={highlightTerm ?? null} />
        ) : (
          (() => {
            // Stable text-segment keys: index into the chip count rather
            // than character offsets, so adding a chip doesn't remount
            // unrelated MarkdownContent subtrees (the markdown-flicker
            // arm of the 字消失 bug).
            let chipIdx = 0;
            return segments.map((seg) => {
              if (seg.kind === 'text') {
                return (
                  <MarkdownContent
                    key={`text-${chipIdx}`}
                    text={seg.text}
                    highlightTerm={highlightTerm ?? null}
                    revealTailChars={seg.revealTailChars}
                  />
                );
              }
              const groupKey = seg.tools[0].id;
              chipIdx += 1;
              // Mobile renders each tool as its own chip (no collapse UI);
              // the projection already coalesces adjacent tools so we just
              // expand the group here.
              return (
                <React.Fragment key={groupKey}>
                  {seg.tools.map((call) => (
                    <ToolChip key={call.id} call={call} />
                  ))}
                </React.Fragment>
              );
            });
          })()
        )}
        {message.streaming && <span className="m-typing"><span /><span /><span /></span>}
      </div>
    </div>
  );
}

function ThoughtBlock({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
      style={{
        marginBottom: 6,
        padding: 6,
        border: '1px dashed var(--term-line)',
        borderRadius: 4,
        fontSize: 11.5,
        color: 'var(--term-muted)',
        cursor: 'pointer',
        whiteSpace: open ? 'pre-wrap' : 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {open ? text : `Thinking… (tap to expand)`}
    </div>
  );
}
