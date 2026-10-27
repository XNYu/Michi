import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PageLayoutPreferences } from 'michi-shared';
import { PageApiError } from '../../../../services/api/pages';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { LayoutPreferencesEditor } from './LayoutPreferencesEditor';

const api = vi.hoisted(() => ({ fetchLayoutPreferences: vi.fn(), saveLayoutPreferences: vi.fn() }));
vi.mock('../../../../services/api/spacesHome', () => api);
const initial: PageLayoutPreferences = { text: 'Keep the summary short', revision: 2, updatedAt: 1, updatedBy: 'user' };
const editor = () => screen.getByRole('textbox', { name: 'Layout preferences' }) as HTMLTextAreaElement;
const save = () => screen.getByRole('button', { name: 'Save preferences' }) as HTMLButtonElement;
const mount = (readOnly = false) => render(<LayoutPreferencesEditor pageId="p1" backendConnectionId="local" readOnly={readOnly} />);

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchLayoutPreferences.mockResolvedValue(initial);
  api.saveLayoutPreferences.mockImplementation(async (_page, input) => {
    const next = { ...initial, text: input.text.trim(), revision: input.expectedRevision + 1 };
    api.fetchLayoutPreferences.mockResolvedValue(next);
    return next;
  });
});

it('saves the whole document with its exact revision and can clear it', async () => {
  mount();
  await screen.findByDisplayValue(initial.text);
  fireEvent.change(editor(), { target: { value: ' Put risks first\nKeep the summary short ' } });
  fireEvent.click(save());
  await screen.findByText('Preferences saved.');
  expect(api.saveLayoutPreferences).toHaveBeenLastCalledWith('p1', { text: ' Put risks first\nKeep the summary short ', expectedRevision: 2 }, 'local');
  expect(editor().value).toBe('Put risks first\nKeep the summary short');
  fireEvent.change(editor(), { target: { value: '' } });
  fireEvent.click(save());
  await waitFor(() => expect(api.saveLayoutPreferences).toHaveBeenLastCalledWith('p1', { text: '', expectedRevision: 3 }, 'local'));
});

it('keeps a focused dirty draft on background changes and requires an explicit conflict choice', async () => {
  mount();
  await screen.findByDisplayValue(initial.text);
  editor().focus();
  fireEvent.change(editor(), { target: { value: 'My draft' } });
  api.fetchLayoutPreferences.mockResolvedValue({ ...initial, text: 'Updated elsewhere', revision: 3 });
  act(() => notifyPageChanged({ backendConnectionId: 'local', pageId: 'p1' }));
  await screen.findByText('Preferences changed elsewhere. Your draft is kept. Review the latest version before replacing it.');
  expect(editor().value).toBe('My draft');
  expect(document.activeElement).toBe(editor());
  expect(save().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Keep my draft' }));
  fireEvent.click(save());
  await screen.findByText('Preferences saved.');
  expect(api.saveLayoutPreferences).toHaveBeenCalledWith('p1', { text: 'My draft', expectedRevision: 3 }, 'local');
});

it('retains the draft after a rejected save, then reads and offers the latest version', async () => {
  mount();
  await screen.findByDisplayValue(initial.text);
  fireEvent.change(editor(), { target: { value: 'My draft' } });
  api.fetchLayoutPreferences.mockResolvedValue({ ...initial, text: 'New saved version', revision: 3 });
  api.saveLayoutPreferences.mockRejectedValueOnce(new PageApiError(409, 'stale_revision', 'Changed elsewhere'));
  fireEvent.click(save());
  await screen.findByRole('button', { name: 'Use latest' });
  expect(editor().value).toBe('My draft');
  fireEvent.click(screen.getByRole('button', { name: 'Use latest' }));
  expect(editor().value).toBe('New saved version');
  expect(save().disabled).toBe(true);
});

it('keeps edits made during a save and bases the next save on the completed revision', async () => {
  let complete!: (value: PageLayoutPreferences) => void;
  api.saveLayoutPreferences.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  mount();
  await screen.findByDisplayValue(initial.text);
  fireEvent.change(editor(), { target: { value: 'First draft' } });
  fireEvent.click(save());
  fireEvent.change(editor(), { target: { value: 'Continued typing' } });
  await act(async () => { complete({ ...initial, text: 'First draft', revision: 3 }); });
  expect(editor().value).toBe('Continued typing');
  expect(screen.queryByText('Preferences changed elsewhere. Your draft is kept. Review the latest version before replacing it.')).toBeNull();
  fireEvent.click(save());
  await waitFor(() => expect(api.saveLayoutPreferences).toHaveBeenLastCalledWith('p1', { text: 'Continued typing', expectedRevision: 3 }, 'local'));
});

it('retains failed drafts, recovers a failed initial read, and does not write while read-only', async () => {
  api.fetchLayoutPreferences.mockRejectedValueOnce(new Error('Offline'));
  const view = mount();
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Offline Retry preferences');
  fireEvent.click(screen.getByRole('button', { name: 'Retry preferences' }));
  await screen.findByDisplayValue(initial.text);
  fireEvent.change(editor(), { target: { value: 'Retained draft' } });
  api.saveLayoutPreferences.mockRejectedValueOnce(new Error('Connection lost'));
  fireEvent.click(save());
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Connection lost');
  expect(editor().value).toBe('Retained draft');
  view.rerender(<LayoutPreferencesEditor pageId="p1" backendConnectionId="local" readOnly />);
  expect(editor().readOnly).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save preferences' })).toBeNull();
  expect(api.saveLayoutPreferences).toHaveBeenCalledTimes(1);
});

it('does not leak a late response or an old draft into a different page', async () => {
  let finish!: (value: PageLayoutPreferences) => void;
  api.fetchLayoutPreferences.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = mount();
  api.fetchLayoutPreferences.mockResolvedValue({ ...initial, text: 'Second page', revision: 1 });
  view.rerender(<LayoutPreferencesEditor pageId="p2" backendConnectionId="local" />);
  await screen.findByDisplayValue('Second page');
  await act(async () => { finish(initial); });
  expect(editor().value).toBe('Second page');
  expect(api.saveLayoutPreferences).not.toHaveBeenCalled();
});
