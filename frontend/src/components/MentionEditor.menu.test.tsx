import React, { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MentionEditor, { type MentionEditorHandle } from './MentionEditor';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function openEditor(text: string) {
  const ref = createRef<MentionEditorHandle>();
  const onSubmit = vi.fn();
  const onChange = vi.fn();
  const view = render(<MentionEditor ref={ref} value="" mentions={[]} onChange={onChange} currentNodeId="current"
    sameTreeNodes={[]} onSubmit={onSubmit}
    artifacts={[{ id: 'notes', name: 'Design notes', filePath: 'notes.md', source: 'user', createdAt: 1, updatedAt: 1 }]} />);
  await waitFor(() => expect(ref.current?.editor).toBeTruthy());
  await act(async () => { ref.current!.editor!.commands.insertContent(text); });
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
  return { ...view, editor: ref.current!.editor!, onSubmit, onChange };
}

describe('Composer autocomplete menus', () => {
  it.each(['@', '/br'])('filters %s implicitly and preserves confirmation feedback', async (text) => {
    const { editor, onSubmit } = await openEditor(text);
    expect(within(screen.getByRole('listbox')).queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    const option = screen.getAllByRole('option')[0];
    if (text === '/br') expect(option.textContent).toContain('Open this message as a new child thread.');
    vi.useFakeTimers();
    fireEvent.mouseDown(option);
    expect(option.classList.contains('ui-menu-blink')).toBe(true);
    expect(editor.getText()).toBe(text);
    act(() => { vi.advanceTimersByTime(160); });
    expect(editor.getText()).toBe(text === '@' ? '@Design notes ' : '/branch ');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(['@', '/br'])('cancels a pending %s selection when typing continues', async (text) => {
    const { editor } = await openEditor(text);
    vi.useFakeTimers();
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);
    await act(async () => { editor.commands.insertContent('z'); });
    act(() => { vi.advanceTimersByTime(200); });
    expect(editor.getText()).toBe(`${text}z`);
  });

  it.each(['@', '/br'])('does not run a %s selection after unmount', async (text) => {
    const { onChange, unmount } = await openEditor(text);
    vi.useFakeTimers();
    fireEvent.mouseDown(screen.getAllByRole('option')[0]);
    unmount();
    onChange.mockClear();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onChange).not.toHaveBeenCalled();
  });
});
