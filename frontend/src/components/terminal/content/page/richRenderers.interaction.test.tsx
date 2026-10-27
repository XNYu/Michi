import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_BLOCK_CATALOG, PAGE_BLOCK_TYPES } from 'michi-shared';
import { MichiBlock, rendererFor } from './MichiBlock';
import { MichiMantine } from './mantine/MichiMantine';
import { asRichBlock } from './richRenderers';
import { MENU_LAYER_SELECTOR, escapeIsForPage } from '../../escapeLayers';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('native rich content', () => {
  it('keeps a renderer for every persisted content type drawn by MichiBlock', () => {
    // NativePageDocument renders resource links, sandboxed components and live Home sections.
    for (const type of PAGE_BLOCK_TYPES.filter((type) => !['page-link', 'component', 'home-section'].includes(type))) expect(rendererFor(type), type).toBeTypeOf('function');
  });

  it('adapts existing charts without changing their stored values or metadata', () => {
    const original = { type: 'chart', id: 'c', kind: 'bar', title: 'Visits', unit: 'people', labels: ['Mon', 'Tue'], series: [{ label: 'Visits', values: [2, 4] }] };
    const before = JSON.stringify(original);
    expect(asRichBlock(original, 0)).toMatchObject({ id: 'c', series: [{ label: 'Visits', points: [{ x: 'Mon', y: 2 }, { x: 'Tue', y: 4 }] }] });
    expect(JSON.stringify(original)).toBe(before);
  });

  it('keeps native identity and every positional value in legacy charts', async () => {
    expect(asRichBlock({ type: 'actions', id: 'page:one/block α', buttons: [{ label: 'Draft', prompt: 'Draft' }] }, 0)?.id).toBe('page:one/block α');
    const block = { type: 'chart', id: 'c', kind: 'bar', title: '', labels: ['Same', 'Same', ''], series: [{ label: 'Visits', values: [2, 4, 8] }] };
    const { container } = render(<MichiBlock block={block} ctx={{ depth: 0 }} />);
    expect([...container.querySelectorAll('tbody td')].map(cell => cell.textContent)).toEqual(['2', '4', '8']);
    expect(asRichBlock({ ...block, labels: ['One', 'Two', 'Three'] }, 0)?.type).toBe('chart');
  });

  it('preserves native image permissions for rich images, avatars and galleries', () => {
    const blocks = [
      { type: 'image', url: 'https://localhost/secret', alt: 'Local' },
      { type: 'person', name: 'Local', avatar: 'https://192.168.1.4/private' },
      { type: 'gallery', title: 'Local', items: [{ url: 'https://127.0.0.1/private' }] },
    ];
    const { container, rerender } = render(<>{blocks.map((block, i) => <MichiBlock key={i} block={block} ctx={{ depth: 0, loadImages: true }} />)}</>);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    rerender(<MichiBlock block={{ type: 'image', url: 'https://example.com/public', alt: 'Public' }} ctx={{ depth: 0 }} />);
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });

  it('keeps native gallery titles and non-loading HTTP pictures', () => {
    render(<MichiBlock block={{ type: 'gallery', title: 'Trip photos', items: [{ url: 'http://example.com/old.jpg', alt: 'Old photo' }] }} ctx={{ depth: 0 }} />);
    expect(screen.getByRole('heading', { name: 'Trip photos' })).toBeTruthy();
    expect(document.querySelector('img[src="http://example.com/old.jpg"]')).toBeNull();
    expect(screen.getByText("HTTP pictures don't load")).toBeTruthy();
  });

  it('starts toggles collapsed and saves nested checklist edits through their owning block', () => {
    const updateBlock = vi.fn();
    render(<MichiBlock block={{ id: 'group', type: 'toggle', title: 'Details', blocks: [{ id: 'group.0', type: 'checklist', items: [{ text: 'Review', done: false }] }] }} ctx={{ depth: 0, updateBlock }} />);
    expect(document.querySelector('details')?.open).toBe(false);
    fireEvent.click(screen.getByText('Details'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Review' }));
    expect(updateBlock).toHaveBeenCalledWith(expect.objectContaining({ id: 'group' }), expect.objectContaining({ id: 'group', blocks: [expect.objectContaining({ items: [{ text: 'Review', done: true }] })] }));
  });

  it('prefills action prompts and prevents duplicate clicks', () => {
    vi.useFakeTimers();
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock block={{ id: 'a', type: 'actions', buttons: [{ label: 'Draft reply', prompt: 'Draft the release reply' }] }} ctx={{ depth: 0, requestAssistant }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Draft reply' }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft reply' }));
    expect(requestAssistant).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a' }), 'Draft the release reply', 'Draft reply', false);
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.click(screen.getByRole('button', { name: 'Draft reply' }));
    expect(requestAssistant).toHaveBeenCalledTimes(2);
  });

  it('validates form answers then prefills them without sending', () => {
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock block={{ ...PAGE_BLOCK_CATALOG.form.example!, id: 'f' }} ctx={{ depth: 0, requestAssistant }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(requestAssistant).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: /City/ }), { target: { value: 'Kyoto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'f' }), 'Plan a trip with these answers\n\n{"city":"Kyoto"}', 'Trip', false);
  });

  it('sends only the visible question and selected poll answer', () => {
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock block={{ ...PAGE_BLOCK_CATALOG.poll.example!, id: 'p' }} ctx={{ depth: 0, requestAssistant }} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Sushi' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vote' }));
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'p' }), 'For “Lunch?” I pick: Sushi', 'Lunch?', true);
  });

  it('makes choices interactive only when the current page can reach its assistant', () => {
    const requestAssistant = vi.fn(() => true);
    const block = { ...PAGE_BLOCK_CATALOG.choice.example!, id: 'c' };
    const { rerender } = render(<MichiBlock block={block} ctx={{ depth: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'East' }));
    expect(requestAssistant).not.toHaveBeenCalled();
    rerender(<MichiBlock block={block} ctx={{ depth: 0, requestAssistant }} />);
    fireEvent.click(screen.getByRole('button', { name: 'East' }));
    expect(requestAssistant).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), 'For “Which route?” I pick: East', 'Which route?', true);
  });

  it('keeps form dropdowns in the page scope and releases Esc when closed', async () => {
    const { container } = render(<MichiMantine dark><MichiBlock block={{ type: 'form', title: 'Trip', fields: [{ key: 'city', label: 'City', type: 'select', options: ['Kyoto', 'Tokyo'] }], prompt: 'Plan a trip' }} ctx={{ depth: 0, requestAssistant: () => true }} /></MichiMantine>);
    expect(container.querySelectorAll('.michi-mantine')).toHaveLength(1);
    fireEvent.click(screen.getByRole('combobox', { name: 'City' }));
    const option = await screen.findByRole('option', { name: 'Kyoto' });
    expect(option.closest('.michi-mantine')).not.toBeNull();
    expect(document.querySelector(MENU_LAYER_SELECTOR)).not.toBeNull();
    fireEvent.click(option);
    await waitFor(() => expect(document.querySelector(MENU_LAYER_SELECTOR)).toBeNull());
    expect(escapeIsForPage(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true);
  });
});
