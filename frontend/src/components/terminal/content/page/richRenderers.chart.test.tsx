import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { MichiPageBlock } from 'michi-shared';
import { MichiBlock } from './MichiBlock';
import type { MichiBlockCtx } from './blockTypes';
import { MichiMantine } from './mantine/MichiMantine';
import { chartSample } from './vendor-blocks/src/desk/component-samples';
import { CHART_KINDS, CHART_KIND_LABELS } from './vendor-blocks/shared/desk-catalog/index';

vi.mock('../../../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <div data-testid="md">{text}</div> }));

const ctx: MichiBlockCtx = { depth: 0, loadImages: true };

function draw(block: MichiPageBlock) {
  return render(<MichiMantine dark={false}><MichiBlock block={block} ctx={ctx} /></MichiMantine>);
}
const sample = (kind: (typeof CHART_KINDS)[number]) => chartSample(kind) as unknown as MichiPageBlock;

afterEach(cleanup);

describe('Desk-drawn chart block', () => {
  it('knows the 12 kinds', () => {
    expect(CHART_KINDS).toHaveLength(12);
  });

  // recharts measures nothing in jsdom, so the picture itself is not asserted: the title, the box that names it
  // for assistive tech, and the legend are.
  it.each(CHART_KINDS)('draws %s from its Desk sample', async (kind) => {
    const block = sample(kind);
    const { container } = draw(block);
    expect(screen.getByRole('heading', { level: 2, name: CHART_KIND_LABELS[kind] })).toBeTruthy();
    await waitFor(() => expect(container.querySelector(`.desk-chart-box[data-kind="${kind}"][role="img"]`)).not.toBeNull());
    expect(container.querySelector('[data-michi-block="unknown"]')).toBeNull();
    expect(container.querySelector('.desk-chart')).not.toBeNull();
  });

  it('names the slices of a donut in its legend, with their numbers', async () => {
    const { container } = draw(sample('pie'));
    await waitFor(() => expect(container.querySelector('.desk-chart-legend')).not.toBeNull());
    const items = [...container.querySelectorAll('.desk-chart-legend li')].map((li) => li.textContent);
    expect(items).toEqual(['Design35', 'Development45', 'Testing20']);
  });

  it('keeps drawing a chart when optional view metadata is attached', async () => {
    const { container } = draw({ ...sample('pie'), visibility: 'detail', interaction: { label: 'Explore data', action: { type: 'open-view', viewId: 'data' } } });
    await waitFor(() => expect(container.querySelector('.desk-chart-legend')).not.toBeNull());
    expect(container.querySelector('[data-michi-block="unknown"]')).toBeNull();
    expect(screen.getByRole('link', { name: /Explore data/ })).toBeTruthy();
  });

  it('gives a bar chart a table for screen readers', async () => {
    const { container } = draw(sample('bar'));
    await waitFor(() => expect(container.querySelector('table.desk-sr')).not.toBeNull());
    expect(container.querySelectorAll('table.desk-sr tbody tr').length).toBeGreaterThan(0);
  });

  it.each([
    ['no series', { type: 'chart', kind: 'bar', title: 'Weekly', series: [] }],
    ['a series without points', { type: 'chart', kind: 'bar', title: 'Weekly', series: [{ label: 'A', points: [] }] }],
    ['an unknown kind', { type: 'chart', kind: 'treemap', title: 'Weekly' }],
    ['a pie without slices', { type: 'chart', kind: 'pie', title: 'Weekly' }],
  ])('falls back to the one-line label for %s', (_name, block) => {
    const { container } = draw(block as unknown as MichiPageBlock);
    const label = container.querySelector('[data-michi-block="unknown"]');
    expect(label?.textContent).toBe('Chart · Weekly');
    expect(container.querySelector('.desk-chart')).toBeNull();
  });
});
