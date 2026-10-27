import React from 'react';
import type { MentionEditorHandle, MentionEditorProps } from '../components/MentionEditor';

/** A textarea standing in for the TipTap composer: same value/onChange/onSubmit contract. */
const MentionEditorStub = React.forwardRef<MentionEditorHandle, MentionEditorProps>(function MentionEditorStub(props, ref) {
  const area = React.useRef<HTMLTextAreaElement>(null);
  React.useImperativeHandle(ref, () => ({ focus: () => area.current?.focus(), editor: null }) as unknown as MentionEditorHandle);
  return (
    <textarea
      ref={area}
      aria-label="Message the assistant"
      value={props.value}
      onChange={(event) => props.onChange({ value: event.target.value, mentions: [] })}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          props.onSubmit?.({ branch: false });
        }
      }}
    />
  );
});

export default MentionEditorStub;
