import React, { createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Editor } from '@tiptap/react';

// useEditor schedules the destruction of the instance it builds during render
// (a 1ms timer that only its mount effect cancels). When the commit is slow,
// the timer wins: the component's effects then run with that destroyed editor
// while useEditor swaps in a replacement for the next render. Destroying the
// first instance during render reproduces that ordering deterministically.
const race = vi.hoisted(() => ({ armed: false, destroyed: [] as unknown[] }));
vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tiptap/react')>();
  return {
    ...actual,
    useEditor: (...args: Parameters<typeof actual.useEditor>) => {
      const editor = actual.useEditor(...args);
      if (race.armed && editor && !editor.isDestroyed) {
        race.armed = false;
        race.destroyed.push(editor);
        editor.destroy();
      }
      return editor;
    },
  };
});

import MentionEditor, { type MentionEditorHandle } from './MentionEditor';
import { composerKeptEscape } from './composerEscape';

describe('MentionEditor across useEditor instance swaps', () => {
  it('renders a draft delivered after the editor mounts', async () => {
    const ref = createRef<MentionEditorHandle>();
    const onChange = vi.fn();
    const view = render(<MentionEditor ref={ref} value="" mentions={[]} onChange={onChange} currentNodeId="current"
      sameTreeNodes={[]} artifacts={[]} onSubmit={() => {}} />);
    await waitFor(() => expect(ref.current?.editor && !ref.current.editor.isDestroyed).toBe(true));
    onChange.mockClear();

    view.rerender(<MentionEditor ref={ref} value="Tell me about Sample" mentions={[]} onChange={onChange} currentNodeId="current"
      sameTreeNodes={[]} artifacts={[]} onSubmit={() => {}} />);
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')?.textContent).toBe('Tell me about Sample'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('survives effects that run with an already-destroyed editor, then listens on its replacement', async () => {
    race.armed = true;
    race.destroyed = [];
    const ref = createRef<MentionEditorHandle>();
    render(<MentionEditor ref={ref} value="" mentions={[]} onChange={() => {}} currentNodeId="current"
      sameTreeNodes={[]} artifacts={[]} onSubmit={() => {}} />);
    expect(race.destroyed).toHaveLength(1);
    await waitFor(() => {
      const editor = ref.current?.editor as Editor | null | undefined;
      expect(editor && !editor.isDestroyed && editor !== race.destroyed[0]).toBe(true);
    });
    const editor = ref.current!.editor as Editor;
    // An Escape that ends an IME composition is still the composer's own.
    const escape = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
    act(() => { editor.view.dom.dispatchEvent(escape); });
    expect(composerKeptEscape(escape)).toBe(true);
  });
});
