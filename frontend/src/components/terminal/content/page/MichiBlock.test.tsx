import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { MichiPageBlock } from 'michi-shared';
import { MichiBlock, rendererFor } from './MichiBlock';
import type { MichiBlockCtx } from './blockTypes';

// Markdown rendering is MarkdownContent's own concern.
vi.mock('../../../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <div data-testid="md">{text}</div> }));

function ctx(extra: Partial<MichiBlockCtx> = {}): MichiBlockCtx {
  return { depth: 0, ...extra };
}

function renderBlock(block: MichiPageBlock, c: MichiBlockCtx = ctx()) {
  return render(<MichiBlock block={block} ctx={c} />);
}

const SAMPLES: MichiPageBlock[] = [
  { type: 'markdown', text: 'Booked **2 of 3** hotels.' },
  { type: 'heading', level: 2, text: 'Next steps' },
  { type: 'text', text: 'Plain words' },
  { type: 'callout', tone: 'warn', title: 'Blockers', text: 'Visa not issued yet.' },
  { type: 'quote', text: 'Ship the smallest thing.', cite: 'Ann' },
  { type: 'divider' },
  { type: 'keyvalue', items: [{ key: 'Owner', value: 'Ann' }] },
  { type: 'stat', label: 'Weekly users', value: '1,240', delta: '+12%', spark: [3, 5, 4, 8] },
  { type: 'metrics', items: [{ label: 'Planned', value: '10 days', hint: 'Oct 10 → Oct 24' }, { label: 'ETA', value: 'Oct 27', tone: 'warn' }] },
  { type: 'progress', title: 'Done', actual: 0.4, expected: 0.6 },
  { type: 'plan-actual', title: 'Plan vs actual', items: [{ label: 'Schema', planned: 2, actual: 3, unit: 'd' }] },
  { type: 'checklist', title: 'Before leaving', items: [{ text: 'Book', done: true }, { text: 'Pack', done: false }] },
  { type: 'compare', title: 'Hotels', options: [{ name: 'Kanra', value: '¥32,000', note: 'Near', lean: true }, { name: 'Ace', note: 'Cheap' }] },
  { type: 'choice', question: 'Which route?', options: ['East', 'West'] },
  { type: 'pros-cons', pros: ['Fast'], cons: ['Costly'] },
  { type: 'table', columns: ['Day', 'Plan'], rows: [['Mon', 'Kyoto']] },
  { type: 'database', title: 'Hotels', columns: [{ id: 'name', name: 'Hotel', type: 'text' }], rows: [{ id: 'r1', values: { name: 'Inn' } }] },
  { type: 'milestones', items: [{ label: 'Spec', date: '2026-10-01', done: true }] },
  { type: 'timeline', items: [{ at: 'Oct 2', title: 'Kickoff' }] },
  { type: 'tags', items: [{ label: 'urgent', tone: 'danger' }, { label: 'docs' }] },
  { type: 'status', label: 'At risk', tone: 'warn', summary: 'Merging lags the code.' },
  { type: 'link', url: 'https://example.com/post', title: 'Release notes' },
  { type: 'code', lang: 'ts', code: 'const x = 1;' },
  { type: 'columns', columns: [[{ type: 'markdown', text: 'Left' }], [{ type: 'markdown', text: 'Right' }]] },
  { type: 'tabs', tabs: [{ label: 'Plan', blocks: [{ type: 'markdown', text: 'A' }] }, { label: 'Actual', blocks: [{ type: 'markdown', text: 'B' }] }] },
  { type: 'toggle', title: 'Details', blocks: [{ type: 'markdown', text: 'Notes.' }] },
];

describe('MichiBlock dispatcher', () => {
  it.each(SAMPLES.map((b) => [b.type, b] as const))('draws %s with its own renderer', (type, block) => {
    expect(rendererFor(type)).toBeDefined();
    const { container } = renderBlock(block);
    expect(container.querySelector(`[data-michi-block="${type}"]`)).not.toBeNull();
    expect(container.querySelector('[data-michi-block="unknown"]')).toBeNull();
  });

  it('shows a block it does not draw as one line with its best label', () => {
    renderBlock({ type: 'chart', kind: 'pie', title: 'Tasks per week', slices: [] });
    expect(screen.getByText('Chart · Tasks per week')).toBeTruthy();
    renderBlock({ type: 'gauge', title: 'CPU' });
    expect(screen.getByText('Gauge · CPU')).toBeTruthy();
    const { container } = renderBlock({ type: 'hologram', id: 'x', caption: 'Spinning cube' });
    expect(container.querySelector('[data-michi-block="unknown"]')?.textContent).toBe('hologram · Spinning cube');
  });

  it('names a wordless unknown block by its kind', () => {
    const { container } = renderBlock({ type: 'mermaid', code: '' });
    expect(container.textContent).toBe('Diagram');
  });

  it('does not draw blocks nested deeper than Michi allows', () => {
    const { container } = renderBlock({ type: 'markdown', text: 'deep' }, ctx({ depth: 3 }));
    expect(container.querySelector('[data-michi-block="unknown"]')).not.toBeNull();
  });

  it('survives malformed blocks', () => {
    const junk: MichiPageBlock[] = [
      { type: 'metrics', items: 'nope' },
      { type: 'plan-actual', items: [{ label: 7, planned: 'x' }, null, { label: 'Ok', planned: 2, actual: 1 }] },
      { type: 'threads', threadIds: 5 },
      { type: 'thread-card', threadId: 'gone' },
      { type: 'checklist', items: [{ text: { a: 1 }, done: 'yes' }] },
      { type: 'compare', options: {} },
      { type: 'choice', options: [1, null, 'B'] },
      { type: 'table', columns: null, rows: [['a'], 'not a row'] },
      { type: 'database', columns: [{ name: 'A' }, 'bad'], rows: [{ values: null }, 3] },
      { type: 'columns', columns: 'x' },
      { type: 'tabs', tabs: [] },
      { type: 'toggle', blocks: [null, { type: 7 }] },
      { type: 'link', url: 'javascript:alert(1)', title: 'Evil' },
      { type: 'heading', text: { not: 'text' } },
      { type: 'stat', spark: ['a', 1] },
      { type: 'progress', actual: 'lots' },
      { type: 'callout', tone: 'shouting' },
      { type: 'keyvalue', items: [{}] },
      { type: 'milestones', items: [{ label: 'x', date: { y: 1 } }] },
      { type: 'tags', items: 'urgent' },
      { type: 'pros-cons' },
      { type: 'code' },
      { type: 'quote' },
    ];
    for (const block of junk) {
      expect(() => renderBlock(block)).not.toThrow();
    }
  });

  it('falls back to the one-line label when a renderer throws', () => {
    const block: MichiPageBlock = { type: 'metrics', title: 'Exploding metrics' };
    Object.defineProperty(block, 'items', { enumerable: false, get() { throw new Error('boom'); } });
    // React reports the caught error; keep the expected noise out of the run.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const swallow = (event: ErrorEvent) => event.preventDefault();
    window.addEventListener('error', swallow);
    const { container } = renderBlock(block);
    window.removeEventListener('error', swallow);
    quiet.mockRestore();
    expect(container.querySelector('[data-michi-block="unknown"]')?.textContent).toBe('Metrics · Exploding metrics');
  });
});

describe('block renderers', () => {
  it('draws plan against actual per row with the numbers in words', () => {
    const { container } = renderBlock({
      type: 'plan-actual',
      title: 'Plan vs actual',
      items: [
        { label: 'Schema', planned: 2, actual: 3, unit: 'd' },
        { label: 'Migration', planned: 4, actual: 4, unit: 'd' },
        { label: 'Tests', planned: 3, actual: 0, unit: 'd' },
      ],
    });
    expect(screen.getByText('Plan vs actual')).toBeTruthy();
    for (const label of ['Schema', 'Migration', 'Tests']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('3d / 2d')).toBeTruthy();
    expect(screen.getByText('4d / 4d')).toBeTruthy();
    expect(screen.getByText('— / 3d')).toBeTruthy();
    expect(screen.getByLabelText('Schema: 3d / 2d, over plan')).toBeTruthy();
    expect(container.querySelectorAll('[data-kind="over"].michi-doc-pa__bar')).toHaveLength(1);
    expect(container.querySelector('.michi-doc-pa__legend')?.textContent).toBe('planactualover plan');
    expect(container.querySelector('.michi-doc-pa__today')).toBeNull();
  });

  it('adds a forecast and a today line when the block carries them', () => {
    const { container } = renderBlock({
      type: 'plan-actual',
      title: 'Plan vs actual',
      today: 7,
      items: [
        { label: 'Migration', planned: 4, actual: 3, forecast: 5, unit: 'd' },
        { label: 'Rollout', planned: 1, actual: 0, unit: 'd' },
      ],
    });
    expect(container.querySelector('.michi-doc-pa__legend')?.textContent).toContain('forecast');
    expect(container.querySelectorAll('[data-kind="forecast"].michi-doc-pa__bar')).toHaveLength(1);
    expect(container.querySelectorAll('.michi-doc-pa__today')).toHaveLength(2);
    expect(screen.getByText('today')).toBeTruthy();
  });

  it('ticks done checklist items read-only and strikes them', () => {
    const { container } = renderBlock({ type: 'checklist', title: 'Before', items: [{ text: 'Book', done: true }, { text: 'Pack', done: false }] });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(boxes.every((b) => b.getAttribute('aria-readonly') === 'true')).toBe(true);
    expect(container.querySelector('li[data-done="true"]')?.textContent).toBe('Book');
    expect(screen.getByText('1/2')).toBeTruthy();
  });

  it('keeps choice buttons disabled outside a page assistant', () => {
    renderBlock({ type: 'choice', question: 'Where on Nov 3?', options: ['Arashiyama', 'Nara'], selected: 0 });
    const group = screen.getByRole('group', { name: 'Where on Nov 3?' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect((group as HTMLFieldSetElement).disabled).toBe(true);
  });

  it('links only https addresses', () => {
    renderBlock({ type: 'link', url: 'https://example.com/post', title: 'Release notes' });
    expect(screen.getByRole('link', { name: /Release notes/ }).getAttribute('href')).toBe('https://example.com/post');
    renderBlock({ type: 'link', url: 'http://example.com/plain', title: 'Plain' });
    expect(screen.queryByRole('link', { name: /Plain/ })).toBeNull();
    expect(screen.getByText('Plain')).toBeTruthy();
  });

  it('switches tabs and starts a toggle collapsed', () => {
    renderBlock({ type: 'tabs', tabs: [{ label: 'Plan', blocks: [{ type: 'text', text: 'Plan body' }] }, { label: 'Actual', blocks: [{ type: 'text', text: 'Actual body' }] }] });
    expect(screen.getByText('Plan body')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Actual' }));
    expect(screen.getByText('Actual body')).toBeTruthy();
    expect(screen.queryByText('Plan body')).toBeNull();

    const actual = screen.getByRole('tab', { name: 'Actual' });
    expect(actual.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Plan' }).tabIndex).toBe(-1);
    fireEvent.keyDown(actual, { key: 'ArrowRight' });
    expect(screen.getByText('Plan body')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Plan' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByText('Actual body')).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByText('Plan body')).toBeTruthy();

    const { container } = renderBlock({ type: 'toggle', title: 'Details', blocks: [{ type: 'text', text: 'Hidden?' }] });
    expect(container.querySelector('details')?.open).toBe(false);
  });

  it("lands a slot's late insert in the tab it was started in", async () => {
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const updateBlock = vi.fn();
    const block: MichiPageBlock = { id: 'tabs-1', type: 'tabs', tabs: [{ label: 'Plan', blocks: [{ type: 'text', text: 'Plan body' }] }, { label: 'Actual', blocks: [{ type: 'text', text: 'Actual body' }] }] };
    renderBlock(block, ctx({
      updateBlock,
      slotAddEntries: (insert) => [{ id: 'board', label: 'Task board', onSelect: () => { void pending.then(() => insert({ type: 'task-view' })); } }],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Plan' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Task board/ }));
    fireEvent.click(screen.getByRole('tab', { name: 'Actual' }));
    expect(screen.getByText('Actual body')).toBeTruthy();
    await act(async () => { release(); await pending; });
    expect(updateBlock).toHaveBeenCalledTimes(1);
    const [owner, next] = updateBlock.mock.calls[0] as [MichiPageBlock, { tabs: Array<{ label: string; blocks: unknown[] }> }];
    expect(owner).toBe(block);
    expect(next.tabs.map((tab) => [tab.label, tab.blocks.length])).toEqual([['Plan', 2], ['Actual', 1]]);
    expect(next.tabs[0]!.blocks[1]).toEqual({ type: 'task-view' });
  });

  it('shows database cells by their column type', () => {
    renderBlock({
      type: 'database',
      title: 'Hotels',
      columns: [
        { id: 'name', name: 'Hotel', type: 'text' },
        { id: 'kind', name: 'Kind', type: 'select', options: [{ value: 'inn', label: 'Ryokan' }] },
        { id: 'bath', name: 'Bath', type: 'checkbox' },
        { id: 'site', name: 'Site', type: 'url' },
      ],
      rows: [{ id: 'r1', values: { name: 'Kanra', kind: 'inn', bath: true, site: 'http://kanra.example' } }],
    });
    expect(screen.getByRole('columnheader', { name: 'Kind' })).toBeTruthy();
    expect(screen.getByText('Ryokan')).toBeTruthy();
    expect(screen.getByLabelText('Yes')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('nests headings without skipping levels', () => {
    renderBlock({ type: 'pros-cons', title: 'Trade-offs', pros: ['Fast'], cons: ['Costly'] });
    expect(screen.getByRole('heading', { level: 3, name: 'Trade-offs' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 4, name: 'Pros' })).toBeTruthy();
    renderBlock({ type: 'pros-cons', pros: ['Quiet'], cons: [] });
    expect(screen.getAllByRole('heading', { level: 3, name: 'Pros' })).toHaveLength(1);
  });

  it('fills a warning callout like the Blockers box', () => {
    const { container } = renderBlock({ type: 'callout', tone: 'warn', title: 'Blockers', text: 'S3 waits.\nS7 stalled.' });
    expect(container.querySelector('.michi-doc-callout')?.getAttribute('data-tone')).toBe('warn');
    expect(screen.getByText('Blockers')).toBeTruthy();
    expect(within(container.querySelector('.michi-doc-callout') as HTMLElement).getByTestId('md').textContent).toBe('S3 waits.\n\nS7 stalled.');
  });
});

describe('page editing hooks in renderers', () => {
  it('ticks a checklist item through the page when it may be edited', () => {
    const toggleItem = vi.fn();
    const block: MichiPageBlock = { type: 'checklist', id: 'cl', title: 'Before', items: [{ text: '', done: false }, { text: 'Pack', done: false }] };
    renderBlock(block, ctx({ toggleItem }));
    const box = screen.getByRole('checkbox', { name: 'Pack' });
    expect(box.getAttribute('aria-readonly')).toBeNull();
    fireEvent.click(box);
    // The index is the item's place in the stored list, blank items included.
    expect(toggleItem).toHaveBeenCalledWith(block, 1);
  });

  it('keeps a checklist without an id read-only', () => {
    renderBlock({ type: 'checklist', title: 'Before', items: [{ text: 'Pack', done: false }] }, ctx({ toggleItem: vi.fn() }));
    expect(screen.getByRole('checkbox', { name: 'Pack' }).getAttribute('aria-readonly')).toBe('true');
  });

  it('shows Pick this on compare options, off until Michi takes the choice', () => {
    renderBlock({ type: 'compare', title: 'Hotels', options: [{ name: 'Kanra', lean: true }, { name: 'Ace' }] });
    const picks = screen.getAllByRole('button', { name: 'Pick this' }) as HTMLButtonElement[];
    expect(picks).toHaveLength(2);
    expect(picks.every((b) => b.disabled && b.title === 'Coming later')).toBe(true);
    expect(screen.getByText('Leaning')).toBeTruthy();
  });

  it('shows an agent-written widget as turned off, with a way to Settings', () => {
    const onNav = vi.fn();
    window.addEventListener('michi:nav-page', onNav);
    const { container } = renderBlock({ type: 'custom', code: '<script>alert(1)</script>', props: { title: 'Weather · Kyoto' } });
    expect(container.querySelector('[data-michi-block="custom"]')?.textContent).toContain('Weather · Kyoto');
    expect(screen.getByText('This widget is turned off')).toBeTruthy();
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).not.toContain('alert(1)');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    window.removeEventListener('michi:nav-page', onNav);
    expect((onNav.mock.calls[0][0] as CustomEvent).detail).toEqual({ page: 'settings' });
  });

  it("hands a container's children to the page's frame, one level down", () => {
    const frame = vi.fn((b: MichiPageBlock, child: MichiBlockCtx) => <div key={String(b.id)} data-framed={String(b.id)} data-depth={child.depth} />);
    const { container } = renderBlock(
      { type: 'columns', id: 'cols', columns: [[{ type: 'markdown', id: 'l', text: 'Left' }], [{ type: 'markdown', id: 'r', text: 'Right' }]] },
      ctx({ frame }),
    );
    expect([...container.querySelectorAll('[data-framed]')].map((el) => [el.getAttribute('data-framed'), el.getAttribute('data-depth')]))
      .toEqual([['l', '1'], ['r', '1']]);
  });

  it("reads a callout's tone out before its words", () => {
    const { container } = renderBlock({ type: 'callout', tone: 'success', title: 'Ready', text: 'Browser pane works.' });
    expect(container.querySelector('.sr-only')?.textContent).toBe('Ready: ');
  });

  it('shows the first eight timeline entries and the rest behind View all', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ title: `Entry ${i}`, at: `Oct ${i + 1}` }));
    const { container } = renderBlock({ type: 'timeline', title: 'Progress', items });
    expect(container.querySelectorAll('li')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'View all 10' }));
    expect(container.querySelectorAll('li')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(container.querySelectorAll('li')).toHaveLength(8);
    expect(container.querySelector('li .michi-doc-dated__when')?.textContent).toBe('Oct 1');
  });

  it('draws milestones as a track: passed, the next one and later ones, each with its note or state', () => {
    const { container } = renderBlock({ type: 'milestones', items: [
      { label: 'Spec', date: '2026-10-01', done: true },
      { label: 'Read-only', date: '2026-12-08', done: false, note: 'Depends on the sample API', tone: 'warn' },
      { label: 'Write pilot', date: '2026-12-21', done: false },
    ] });
    const items = [...container.querySelectorAll('ol.michi-doc-track > li')];
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual(['done', 'next', 'later']);
    expect(items.map((li) => li.querySelector('.michi-doc-track__note')?.textContent)).toEqual(['Done', 'Depends on the sample API', 'Planned']);
    expect(items[1].getAttribute('data-tone')).toBe('warn');
    expect(items[0].querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-01');
  });

  it('draws a long run of milestones as a dated list', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ label: `Step ${i}`, date: `Week ${i}`, done: i < 2, ...(i === 3 ? { note: 'Blocked' } : {}) }));
    const { container } = renderBlock({ type: 'milestones', items });
    expect(container.querySelector('.michi-doc-track')).toBeNull();
    expect(container.querySelectorAll('ul.michi-doc-dated > li')).toHaveLength(7);
    expect(screen.getByText('Blocked')).toBeTruthy();
  });

  it('draws the page status as a toned badge beside its summary, with its note', () => {
    const { container, unmount } = renderBlock({ type: 'status', label: 'At risk', tone: 'warn', summary: 'Merging lags the code.', note: 'From the Oct 23 reports' });
    const badge = container.querySelector('.michi-doc-status__badge');
    expect(badge?.textContent).toBe('At risk');
    expect(badge?.getAttribute('data-tone')).toBe('warn');
    expect(container.querySelector('.michi-doc-status__summary')?.textContent).toBe('Merging lags the code.');
    expect(container.querySelector('.michi-doc-status__note')?.textContent).toBe('From the Oct 23 reports');
    unmount();
    const bare = renderBlock({ type: 'status', label: 'On track', tone: 'unknown' });
    expect(bare.container.querySelector('.michi-doc-status__summary')).toBeNull();
    expect(bare.container.querySelector('.michi-doc-status__badge')?.hasAttribute('data-tone')).toBe(false);
  });

  it('draws next steps without a start action unless the page offers one', () => {
    const block: MichiPageBlock = { type: 'next-steps', items: [{ who: 'agent', text: 'Run tests' }, { who: 'user', text: '' }] };
    const { container, unmount } = renderBlock(block);
    expect(container.querySelectorAll('.michi-doc-steps__item')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Start a conversation' })).toBeNull();
    unmount();
    const startConversation = vi.fn();
    renderBlock(block, ctx({ startConversation }));
    fireEvent.click(screen.getByRole('button', { name: 'Start a conversation' }));
    expect(startConversation).toHaveBeenCalledWith('Run tests');
  });
});

describe('native conversation blocks', () => {
  it('delegates native node references to the workspace renderer', () => {
    const block = { type: 'threads', title: 'Sessions', nodeIds: ['n1', 'n2'] };
    const renderNativeThreads = vi.fn(() => <button>Open native conversation</button>);
    renderBlock(block, ctx({ renderNativeThreads }));
    expect(renderNativeThreads).toHaveBeenCalledWith(block);
    expect(screen.getByRole('button', { name: 'Open native conversation' })).toBeTruthy();
  });
  it('shows an unavailable state without a workspace renderer', () => {
    renderBlock({ type: 'threads', nodeIds: ['n1'] });
    expect(screen.getByRole('status').textContent).toContain('unavailable');
  });
});
