import React, { createRef } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import MentionEditor, { type MentionEditorHandle } from './MentionEditor';

// A selection set by script reaches ProseMirror on the next selectionchange
// task; a key can get there first (input runs ahead of queued tasks while the
// main thread is busy). jsdom never fires selectionchange on its own, which
// holds the editor in exactly that state.
describe('MentionEditor with a selection ProseMirror has not read yet', () => {
  async function setup(anchor: 'root' | 'paragraph') {
    const ref = createRef<MentionEditorHandle>();
    const onChange = vi.fn();
    const view = render(<MentionEditor ref={ref} value="A real question" mentions={[]} onChange={onChange} currentNodeId="current"
      sameTreeNodes={[]} artifacts={[]} onSubmit={() => {}} />);
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')?.textContent).toBe('A real question'));
    const editor = ref.current!.editor!;
    // ProseMirror reads selections only while it has focus; jsdom focuses
    // a contenteditable only when it is otherwise focusable.
    editor.view.dom.setAttribute('tabindex', '0');
    act(() => { editor.view.dom.focus(); editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
    expect(editor.state.selection.empty).toBe(true);
    // Select everything in the DOM only. Playwright's fill('') anchors the
    // range on the editor root.
    const range = document.createRange();
    range.selectNodeContents(anchor === 'root' ? editor.view.dom : editor.view.dom.querySelector('p')!);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    expect(editor.state.selection.empty).toBe(true);
    return { editor, onChange };
  }

  for (const key of ['Delete', 'Backspace']) {
    for (const anchor of ['root', 'paragraph'] as const) {
      it(`${key} deletes the browser's selection (anchored on the ${anchor}), not the stale caret`, async () => {
        const { editor, onChange } = await setup(anchor);
        act(() => {
          editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
        expect(editor.isEmpty).toBe(true);
        expect(onChange).toHaveBeenLastCalledWith({ value: '', mentions: [] });
      });
    }
  }

  it('leaves its own caret alone when the browser has no range to give', async () => {
    const { editor, onChange } = await setup('paragraph');
    const caret = editor.state.selection.from;
    document.getSelection()!.removeAllRanges();
    act(() => {
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }));
    });
    // (A one-character Backspace is the browser's native edit, which jsdom does not perform.)
    expect(editor.state.selection.from).toBe(caret);
    expect(editor.state.selection.empty).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });
});
