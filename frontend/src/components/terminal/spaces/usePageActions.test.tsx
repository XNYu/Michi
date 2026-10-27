import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSummaryDto } from 'michi-shared';
import { usePageActions } from './usePageActions';

const api = vi.hoisted(() => ({ createPage: vi.fn(), deletePage: vi.fn(), fetchPage: vi.fn(), patchPage: vi.fn(), notify: vi.fn() }));
vi.mock('../../../services/api/pages', () => api);
vi.mock('../../../state/pages/pageEvents', () => ({ notifyPageChanged: api.notify }));

const summary = (id: string, parentId: string | null, title = id): PageSummaryDto => ({
  id, parentId, title, workspaceId: 'ws', position: 0, color: null, updatedAt: 1, updatedBy: 'user', pendingProposals: 0, helperNodeId: null,
});
const pages = [summary('root', null, 'Release'), summary('child', 'root', 'Notes'), summary('nested', 'child'), summary('sibling', 'root', 'Review'), summary('other', null, 'Other Space')];
const identity = { workspaceId: 'ws', backendConnectionId: 'local' };
const onOpen = vi.fn();
const onChanged = vi.fn();
const onTrashed = vi.fn();
function Harness({ readOnly = false }: { readOnly?: boolean }) {
  const actions = usePageActions({ identity, pages, readOnly, onOpen, onChanged, onTrashed });
  return <>
    <button onClick={() => actions.createChild('child')}>Create</button>
    <button onClick={() => actions.rename(pages[1])}>Rename</button>
    <button onClick={() => actions.move(pages[1])}>Move</button>
    <button onClick={() => actions.trash(pages[1])}>Trash</button>
    {actions.dialog}
  </>;
}

describe('shared page actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchPage.mockResolvedValue({ ...pages[1], revision: 9 });
    api.patchPage.mockResolvedValue({});
    api.createPage.mockResolvedValue({ id: 'new-child' });
    api.deletePage.mockResolvedValue({});
  });

  it('renames with the latest revision and notifies both document and sidebar consumers', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Updated notes ' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.patchPage).toHaveBeenCalledWith('child', { revision: 9, title: 'Updated notes' }, identity));
    expect(api.notify).toHaveBeenCalledWith({ ...identity, pageId: 'child' });
    expect(onChanged).toHaveBeenCalledWith('child');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('creates under the selected page and opens the saved child', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Create'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Design' } });
    fireEvent.click(screen.getByText('Create page'));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith('new-child'));
    expect(api.createPage).toHaveBeenCalledWith({ workspaceId: 'ws', parentId: 'child', title: 'Design' }, identity);
  });

  it('moves by page name, excluding the page, descendants and other Spaces', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Move'));
    const dialog = screen.getByRole('dialog', { name: 'Move page' });
    expect(within(dialog).getAllByRole('option').map(option => option.textContent)).toEqual(['Top level (new page)', 'Release', 'Review']);
    fireEvent.change(screen.getByLabelText('Move under'), { target: { value: 'sibling' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() => expect(api.patchPage).toHaveBeenCalledWith('child', { revision: 9, parentId: 'sibling' }, identity));
  });

  it('requires confirmation before moving a page tree to trash and supports cancelling', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('Trash'));
    expect(api.deletePage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    expect(api.deletePage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Trash'));
    fireEvent.click(screen.getByRole('button', { name: 'Move to trash' }));
    await waitFor(() => expect(onTrashed).toHaveBeenCalledWith(pages[1]));
    expect(api.deletePage).toHaveBeenCalledWith('child', identity);
  });

  it('retains the entered name after a failed write so it can be retried', async () => {
    api.patchPage.mockRejectedValueOnce(new Error('The page changed. Try again.'));
    render(<Harness />);
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep these words' } });
    fireEvent.click(screen.getByText('Save'));
    await screen.findByRole('alert');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Keep these words');
    expect(api.notify).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.patchPage).toHaveBeenCalledTimes(2);
  });

  it('prevents duplicate submissions and blocks writes when the tree becomes read-only', async () => {
    let finish!: (value: object) => void;
    api.patchPage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<Harness />);
    fireEvent.click(screen.getByText('Rename'));
    const form = screen.getByLabelText('Name').closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(api.patchPage).toHaveBeenCalledTimes(1));
    finish({});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByText('Rename'));
    view.rerender(<Harness readOnly />);
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
    expect(api.patchPage).toHaveBeenCalledTimes(1);
  });
});
