import React, { createRef, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MentionRecord } from './mentions';

import type MentionEditorComponent from './MentionEditor';
import type { MentionEditorHandle } from './MentionEditor';

let resolveMentionEditor: ((module: { default: typeof MentionEditorComponent }) => void) | null = null;
const LazyMentionEditor = lazy(() => new Promise<{ default: typeof MentionEditorComponent }>((resolve) => {
  resolveMentionEditor = resolve;
}));

const requestedDraft = 'Tell me about Sample';

/** Mirrors TPane's synchronous latest-draft ref and frame-delayed React render. */
function DraftStoreHarness({ editorRef, onChange }: {
  editorRef: React.Ref<MentionEditorHandle>;
  onChange: (draft: { value: string; mentions: MentionRecord[] }) => void;
}) {
  const latestDraft = useRef('');
  const [value, setValue] = useState('');

  useEffect(() => {
    // TPane applies the request in an effect and updates its synchronous draft
    // source immediately, while the editor still sees the preceding render.
    latestDraft.current = requestedDraft;
    requestAnimationFrame(() => setValue(latestDraft.current));
  }, []);

  return <Suspense fallback={<div>Loading editor</div>}>
    <LazyMentionEditor
      value={value}
      mentions={[] as MentionRecord[]}
      ref={editorRef}
      onChange={(draft) => {
        // Model a TipTap update writing through TPane's synchronous ref before
        // its next render. An empty mount-time update would overwrite the ask.
        latestDraft.current = draft.value;
        requestAnimationFrame(() => setValue(latestDraft.current));
        onChange(draft);
      }}
      currentNodeId="page-helper"
      sameTreeNodes={[]}
      artifacts={[]}
    />
  </Suspense>;
}

describe('MentionEditor lazy mount with a pending page-helper draft', () => {
  it('keeps the requested text when the editor mounts before the draft render RAF', async () => {
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    resolveMentionEditor = null;
    const editorRef = createRef<MentionEditorHandle>();
    const onChange = vi.fn();

    try {
      const view = render(<DraftStoreHarness editorRef={editorRef} onChange={onChange} />);
      // The request effect has run and queued the nonempty store value, but the
      // component is still suspended. Mount the real editor before that frame.
      expect(frames).toHaveLength(1);
      expect(resolveMentionEditor).toBeTypeOf('function');
      await act(async () => {
        resolveMentionEditor!({ default: (await import('./MentionEditor')).default });
      });
      await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull());
      // The editor's initial no-op update must not overwrite the synchronous
      // draft ref while its controlled value is still the preceding empty one.
      expect(onChange).not.toHaveBeenCalled();

      // Flush queued React/store writes. In the failure ordering, an empty
      // editor initialization update replaces latestDraft before this callback.
      await act(async () => {
        while (frames.length > 0) {
          const batch = frames.splice(0);
          for (const callback of batch) callback(0);
        }
      });

      expect(view.container.querySelector('.ProseMirror')?.textContent).toBe(requestedDraft);
      expect(frames.length).toBe(0);

      // Once the requested text is present, a real document change (including
      // deleting all text) must still propagate through the controlled API.
      act(() => { editorRef.current?.editor?.commands.clearContent(); });
      expect(onChange).toHaveBeenLastCalledWith({ value: '', mentions: [] });
    } finally {
      raf.mockRestore();
    }
  });
});
