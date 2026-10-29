import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { PageBlock, PageSummaryDto } from 'michi-shared';
import { SpaceOutline, pageOutline } from './SpaceOutline';

const block = (id: string, content: Record<string, unknown>) => ({ id, rev: 1, ...content }) as unknown as PageBlock;
const BLOCKS = [
  block('t', { type: 'threads', nodeIds: ['n1'] }),
  block('h1', { type: 'heading', text: 'Progress' }),
  block('pa', { type: 'plan-actual', items: [{ label: 'Build', planned: 2, actual: 3 }] }),
  block('m', { type: 'markdown', text: '### Notes\nSome words' }),
  block('k', { type: 'metrics', items: [{ label: 'Done', value: '14' }] }),
  block('h2', { type: 'heading', text: 'Blockers' }),
  block('c', { type: 'callout', title: 'Schema naming', text: 'Waiting on you', tone: 'warn' }),
  block('ch', { type: 'chart', title: 'Turns per day', kind: 'bar', labels: ['14'], series: [{ label: 'Kiro', values: [3] }] }),
  block('blank', { type: 'heading', text: '  ' }),
];

describe('Space outline', () => {
  it('omits content reserved for a named view', () => {
    expect(pageOutline([
      block('detail-title', { type: 'heading', text: 'Hidden evidence', visibility: 'detail' }),
      block('definition', { type: 'view', viewId: 'evidence', title: 'Evidence', blockIds: ['detail-title'] }),
      block('visible', { type: 'chart', title: 'Progress' }),
    ])).toEqual([{ id: 'visible', text: 'Progress', depth: 1 }]);
  });

  it('lists the headings, and the titled blocks under them one step in', () => {
    expect(pageOutline(BLOCKS)).toEqual([
      { id: 't', text: 'Threads', depth: 1 },
      { id: 'h1', text: 'Progress', depth: 1 },
      { id: 'pa', text: 'Plan vs actual', depth: 2 },
      { id: 'h2', text: 'Blockers', depth: 1 },
      { id: 'c', text: 'Schema naming', depth: 2 },
      { id: 'ch', text: 'Turns per day', depth: 2 },
    ]);
  });

  it('scrolls to the block an entry names', () => {
    const target = document.createElement('div');
    target.id = 'page-block-ch';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    const page = { id: 'p', title: 'Home', parentId: null, position: 0, pendingProposals: 0 } as unknown as PageSummaryDto;
    render(<SpaceOutline pages={[page]} activePageId="p" rootId="p" blocks={BLOCKS} readOnly onOpen={vi.fn()} onCreateChild={vi.fn()} onRename={vi.fn()} onMove={vi.fn()} onTrash={vi.fn()} />);
    const nav = screen.getByRole('navigation', { name: 'Page outline' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Turns per day' }));
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    target.remove();
  });
});
