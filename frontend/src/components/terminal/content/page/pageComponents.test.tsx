import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { MichiPageBlock } from 'michi-shared';
import { MichiBlock } from './MichiBlock';
import type { MichiBlockCtx } from './blockTypes';
import { planScheduleModel } from './michiPageModel';
import { isPrivateImageHost, loadableImageUrl } from '../../../../lib/pictureAddress';

// Markdown rendering is MarkdownContent's own concern; the block only picks its features.
vi.mock('../../../MarkdownContent', () => ({ default: ({ text, features }: { text: string; features?: Record<string, unknown> }) => <div data-testid="md" data-https-images={String(features?.httpsImages === true)}>{text}</div> }));

const NOW = new Date(2026, 9, 21, 12).getTime();
const ctx = (extra: Partial<MichiBlockCtx> = {}): MichiBlockCtx => ({ depth: 0, now: NOW, ...extra });
const draw = (block: MichiPageBlock, c: MichiBlockCtx = ctx()) => render(<MichiBlock block={block} ctx={c} />);

describe('compare', () => {
  const block: MichiPageBlock = { type: 'compare', id: 'c1', title: 'Where to stay', options: [
    { name: 'Hotel Kanra', value: '¥32,000', unit: '/ night', pros: ['Near the station'], cons: ['¥3,500 more'], lean: true },
    { name: 'Ace Hotel', value: '¥28,500', unit: '/ night', pros: ['3 minutes from Karasuma'] },
  ] };

  it('records the pick on the block, and the pick replaces the leaning', () => {
    const updateBlock = vi.fn();
    const { rerender } = draw(block, ctx({ updateBlock }));
    expect(screen.getByText('Leaning')).toBeTruthy();
    expect(screen.getByText('Con:', { exact: false }).closest('li')?.textContent).toBe('Con: ¥3,500 more');
    fireEvent.click(screen.getAllByRole('button', { name: 'Pick this' })[1]);
    expect(updateBlock).toHaveBeenCalledWith(block, { ...block, picked: 1 });
    rerender(<MichiBlock block={{ ...block, picked: 1 }} ctx={ctx({ updateBlock })} />);
    expect(screen.queryByText('Leaning')).toBeNull();
    const picked = screen.getByRole('button', { name: 'Picked' }) as HTMLButtonElement;
    expect(picked.disabled).toBe(true);
    expect(picked.closest('li')?.getAttribute('data-picked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Pick this' })).toHaveProperty('disabled', false);
  });
});

describe('conflict', () => {
  const block: MichiPageBlock = { type: 'conflict', id: 'k1', question: 'Where do we go on November 3?', options: [
    { text: 'Arashiyama', from: 'Kiro', at: '2026-10-14', nodeId: 'n-kiro' },
    { text: 'A day trip to Nara', from: 'Claude Code', at: '2026-10-17' },
  ] };

  it('keeps the version chosen, or both', () => {
    const updateBlock = vi.fn();
    draw(block, ctx({ updateBlock }));
    const keep = screen.getByRole('button', { name: 'Keep this' }) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Nara/ }));
    fireEvent.click(keep);
    expect(updateBlock).toHaveBeenLastCalledWith(block, { ...block, resolution: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Both are fine' }));
    expect(updateBlock).toHaveBeenLastCalledWith(block, { ...block, resolution: 'both' });
  });

  it('marks what was kept, and lets the person change it', () => {
    const updateBlock = vi.fn();
    draw({ ...block, resolution: 0 }, ctx({ updateBlock }));
    expect(screen.getByText('Kept').closest('label')?.textContent).toContain('Arashiyama');
    expect(screen.getByRole('radio', { name: /Nara/ }).closest('label')?.getAttribute('data-muted')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    fireEvent.click(screen.getByRole('radio', { name: /Nara/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateBlock).not.toHaveBeenCalled();
    expect(screen.getByText('Kept').closest('label')?.textContent).toContain('Arashiyama');
  });

  it('starts the choice again from what is kept when the block changes under it', () => {
    const updateBlock = vi.fn();
    const { rerender } = draw(block, ctx({ updateBlock }));
    fireEvent.click(screen.getByRole('radio', { name: /Nara/ }));
    // An agent rewrites the versions: the half-made choice clears.
    rerender(<MichiBlock block={{ ...block, options: [{ text: 'Arashiyama' }, { text: 'Kyoto Station' }] }} ctx={ctx({ updateBlock })} />);
    expect((screen.getByRole('button', { name: 'Keep this' }) as HTMLButtonElement).disabled).toBe(true);
    // Kept in another window: Change starts from the version kept.
    rerender(<MichiBlock block={{ ...block, resolution: 1 }} ctx={ctx({ updateBlock })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect((screen.getByRole('radio', { name: /Nara/ }) as HTMLInputElement).checked).toBe(true);
    expect(updateBlock).not.toHaveBeenCalled();
  });

  it('opens the conversation a version came from, and stays read-only without a page to save to', () => {
    const openConversation = vi.fn();
    draw(block, ctx({ openConversation }));
    fireEvent.click(screen.getByRole('button', { name: 'Open the conversation in Kiro' }));
    expect(openConversation).toHaveBeenCalledWith('n-kiro');
    expect(screen.queryByRole('button', { name: 'Keep this' })).toBeNull();
    expect(screen.getAllByRole('radio').every((radio) => (radio as HTMLInputElement).disabled)).toBe(true);
    expect(screen.queryByRole('button', { name: /Claude Code/ })).toBeNull();
  });
});

describe('success criteria', () => {
  it('says each state in words, with the figure where there is one', () => {
    draw({ type: 'criteria', items: [
      { text: 'All sessions merged', state: 'in-progress', now: '6 / 11', from: 'git · main' },
      { text: 'Old config removed', state: 'not-started', from: 'plan.md' },
    ] });
    const table = screen.getByRole('table', { name: 'Success criteria' });
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual(['Criterion', 'Now', 'From']);
    const [, merged, removed] = within(table).getAllByRole('row');
    expect(merged.textContent).toBe('All sessions mergedin progress: 6 / 11git · main');
    expect(removed.textContent).toBe('Old config removednot startedplan.md');
  });
});

describe('chart', () => {
  // Load the real chart module before timing DOM assertions against its lazy wrapper.
  beforeAll(async () => {
    await import('./vendor-blocks/src/desk/blocks/catalog/chart/kinds');
  });

  it('draws stored native chart values with Mantine and keeps units and zeroes accessible', async () => {
    const { container } = draw({ type: 'chart', title: 'Turns per day', kind: 'bar', stacked: true, labels: ['14', '15'], unit: 'turns', series: [
      { label: 'KiroCrew', values: [38, 0] }, { label: 'Claude Code', values: [10, 8] },
    ] });
    const table = await screen.findByRole('table', { name: 'Turns per day' });
    expect(within(table).getAllByRole('row').map((row) => row.textContent)).toEqual(['KiroCrewClaude Code', '143810', '1508']);
    expect(screen.getByText('turns')).toBeTruthy();
    expect(container.querySelector('.desk-chart-box')?.getAttribute('data-kind')).toBe('bar');
  });

  it('draws point-based lines and keeps a missing value as a gap', async () => {
    const { container } = draw({ type: 'chart', title: 'Tasks', kind: 'line', series: [
      { label: 'Done', points: [{ x: 'Mon', y: 2 }, { x: 'Tue', y: 5 }] }, { label: 'Open', points: [{ x: 'Tue', y: 1 }] },
    ] });
    const table = await screen.findByRole('table', { name: 'Tasks' });
    expect(container.querySelector('.desk-chart-box')?.getAttribute('data-kind')).toBe('line');
    expect(within(table).getAllByRole('row').map((row) => row.textContent)).toEqual(['DoneOpen', 'Mon2', 'Tue51']);
    expect(within(table).getAllByRole('row')[1].lastElementChild?.textContent).toBe('');
  });
});

describe('gallery', () => {
  const block: MichiPageBlock = { type: 'gallery', items: [
    { url: 'https://images.example.com/a.jpg', caption: 'Kiyomizu-dera', alt: 'A temple' },
    { url: 'http://example.com/map.png', caption: 'Map' },
    { url: 'https://192.168.1.4/cam.jpg', caption: 'Camera' },
  ] };

  it('loads an https picture on the internet by itself, where the page allows pictures', () => {
    const { container } = draw(block, ctx({ loadImages: true }));
    const pictures = [...container.querySelectorAll('figure')];
    expect(pictures.map((figure) => figure.getAttribute('data-state'))).toEqual(['shown', 'insecure', 'off']);
    expect(container.querySelectorAll('img')).toHaveLength(1);
    const image = screen.getByRole('img', { name: 'A temple' });
    expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(within(pictures[1]).getByText("HTTP pictures don't load")).toBeTruthy();
    // An http address is shown as its address, never as a link.
    expect(within(pictures[1]).queryByRole('link')).toBeNull();
    expect(within(pictures[1]).getByText('http://example.com/map.png')).toBeTruthy();
    fireEvent.error(image);
    expect(within(pictures[0]).getByText("Couldn't load")).toBeTruthy();
    expect(within(pictures[0]).getByRole('link', { name: 'Original link ↗' }).getAttribute('href')).toBe('https://images.example.com/a.jpg');
  });

  it('loads nothing on a page that does not load pictures', () => {
    const { container } = draw(block);
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getAllByText('Not loaded here')).toHaveLength(2);
  });

  it('keeps pictures on this machine and its network from loading', () => {
    for (const host of ['localhost', 'localhost.', 'app.localhost', 'printer.local', 'printer.local.', 'metadata.google.internal.', 'nas', 'router.lan', 'box.home.arpa',
      '10.0.0.8', '100.64.0.1', '100.127.255.254', '172.20.1.1', '192.168.1.4', '169.254.0.1', '127.0.0.1', '0.0.0.0', '224.0.0.251', '255.255.255.255',
      '[::]', '[::1]', '[fd12::1]', '[fe80::1]', '[fe90::1]', '[febf::1]', '[ff02::1]', '[::ffff:7f00:1]', '[::7f00:1]', '[64:ff9b::7f00:1]']) {
      expect(isPrivateImageHost(host), host).toBe(true);
    }
    for (const host of ['images.unsplash.com', '8.8.8.8', '100.128.0.1', '172.32.0.1', '[2606:4700::1111]']) expect(isPrivateImageHost(host), host).toBe(false);
    expect(loadableImageUrl('https://[::127.0.0.1]/a.jpg')).toBeNull();
    expect(loadableImageUrl('https://0x7f.1/a.jpg')).toBeNull();
    expect(loadableImageUrl(' https://images.unsplash.com/a.jpg ')).toBe('https://images.unsplash.com/a.jpg');
    expect(loadableImageUrl('https://2130706433/a.jpg')).toBeNull();
    expect(loadableImageUrl('http://images.unsplash.com/a.jpg')).toBeNull();
    expect(loadableImageUrl('data:image/png;base64,AAAA')).toBeNull();
  });
});

describe('you may have forgotten', () => {
  it('says what shipped and when, and what stopped halfway', () => {
    const { container } = draw({ type: 'forgot', items: [
      { title: 'Orbit layout', state: 'shipped', at: '2026-09-28', detail: 'Map → Layout → Orbit' },
      { title: 'Streamdown renderer', state: 'unfinished', detail: 'Code highlighting not moved over' },
    ] });
    expect(screen.getByRole('heading', { name: 'You may have forgotten' })).toBeTruthy();
    const [shipped, unfinished] = [...container.querySelectorAll('.michi-doc-forgot__item')];
    expect(shipped.textContent).toMatch(/^Orbit layoutshipped (2026-)?09-28Map → Layout → Orbit$/);
    expect(unfinished.textContent).toBe('Streamdown rendererhalf doneCode highlighting not moved over');
  });
});

describe('plan vs actual in days', () => {
  const block: MichiPageBlock = { type: 'plan-actual', items: [
    { label: 'Schema', planStart: '2026-10-10', planEnd: '2026-10-14', actualStart: '2026-10-10', actualEnd: '2026-10-16' },
    { label: 'Migration', planStart: '2026-10-15', planEnd: '2026-10-22', actualStart: '2026-10-17', forecastEnd: '2026-10-24' },
    { label: 'Tests', planStart: '2026-10-23', planEnd: '2026-10-25' },
  ] };

  it('runs work under way to today, marks the overrun, and forecasts from tomorrow', () => {
    const model = planScheduleModel(block, NOW);
    const days = 16; // Oct 10 to Oct 25, both counted
    const [schema, migration, tests] = model.rows;
    expect(schema.plan).toEqual({ start: 0, width: 5 / days });
    expect(schema.actual).toEqual({ start: 0, width: 5 / days });
    expect(schema.over).toEqual({ start: 5 / days, width: 2 / days });
    expect(schema.text).toBe('7d / 5d');
    expect(migration.actual).toEqual({ start: 7 / days, width: 5 / days });
    expect(migration.over).toBeNull();
    expect(migration.forecast).toEqual({ start: 12 / days, width: 3 / days });
    expect(migration.words).toBe('Migration: planned Oct 15 to Oct 22; actual Oct 17 to today; forecast to Oct 24');
    expect(tests.actual).toBeNull();
    expect(tests.text).toBe('— / 3d');
    expect(model.today).toBe(11.5 / days);
    expect(model.axis.map((label) => label.kind)).toEqual(['start', 'today', 'end']);
    expect(model.hasOver && model.hasForecast).toBe(true);
  });

  it('draws the rows with their words and the legend for what they show', () => {
    const { container } = draw(block);
    expect(screen.getByRole('heading', { name: 'Plan vs actual' })).toBeTruthy();
    expect([...container.querySelectorAll('.michi-doc-pa__key')].map((key) => key.textContent)).toEqual(['plan', 'actual', 'over plan', 'forecast']);
    expect(container.querySelector('[aria-label^="Schema"]')?.getAttribute('aria-label')).toBe('Schema: planned Oct 10 to Oct 14; actual Oct 10 to Oct 16; over plan');
    expect(container.querySelectorAll('.michi-doc-pa__today')).toHaveLength(3);
  });
});

describe('Markdown pictures', () => {
  it('loads https pictures in text only where the page loads pictures', () => {
    const { rerender } = draw({ type: 'markdown', text: '![Map](https://example.com/map.png)' }, ctx({ loadImages: true }));
    expect(screen.getByTestId('md').getAttribute('data-https-images')).toBe('true');
    rerender(<MichiBlock block={{ type: 'markdown', text: '![Map](https://example.com/map.png)' }} ctx={ctx()} />);
    expect(screen.getByTestId('md').getAttribute('data-https-images')).toBe('false');
  });
});
