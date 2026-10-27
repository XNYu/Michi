import React, { useId } from 'react';
import type { MichiPageBlock } from 'michi-shared';
import type { BlockProps, BlockRenderer } from './blockTypes';
import type { PageBlock, PageBlockWithSources } from './vendor-blocks/shared/desk-blocks';
import { validateBlock } from './vendor-blocks/shared/desk-catalog/index';
import type { BlockProps as DeskBlockProps } from './vendor-blocks/src/desk/blocks/types';
import { ChartBlock } from './vendor-blocks/src/desk/blocks/catalog/chart/ChartBlock';
import { GaugeBlock, LeaderboardBlock, RatingBlock, RingBlock } from './vendor-blocks/src/desk/blocks/catalog/data';
import { AgendaBlock, CalendarBlock, ClocksBlock, CountdownBlock, GanttBlock, StepperBlock } from './vendor-blocks/src/desk/blocks/catalog/time';
import { MEDIA_RENDERERS } from './vendor-blocks/src/desk/blocks/catalog/media';
import { ActionsBlock, FormBlock, PollBlock } from './vendor-blocks/src/desk/blocks/catalog/interactive';
import { DiffBlock } from './vendor-blocks/src/desk/blocks/catalog/text/Diff';
import { MathBlock } from './vendor-blocks/src/desk/blocks/catalog/text/Math';
import { MermaidBlock } from './vendor-blocks/src/desk/blocks/catalog/text/Mermaid';
import { TocBlock } from './vendor-blocks/src/desk/blocks/catalog/text/Toc';
import { MichiMantine } from './mantine/MichiMantine';
import { GalleryBlock as NativeGalleryFallback } from './blocks/media';
import { ChartBlock as NativeChartFallback } from './blocks/chart';
import { loadableImageUrl } from '../../../../lib/pictureAddress';
import { PageImagesContext } from './vendor-blocks/src/vendor/michi/components/MarkdownImage';
import './richCss/chart.css';
import './richCss/data-time.css';
import './richCss/media.css';
import './richCss/interactive-text.css';

type Type = PageBlock['type'];
type DeskRenderer<K extends Type> = (props: DeskBlockProps<K>) => React.ReactNode;

/** The vendor catalog supplies display defaults for copied renderers. Native
 * write validation remains authoritative; this conversion never writes a page. */
const read = new WeakMap<MichiPageBlock, Map<number, PageBlockWithSources | null>>();
/** The block as Desk's catalog reads it at `depth`, or null; it keeps the page's own id, as Michi's page links name it. */
export function asRichBlock(block: MichiPageBlock, depth: number): PageBlockWithSources | null {
  let byDepth = read.get(block);
  if (!byDepth) read.set(block, (byDepth = new Map()));
  if (!byDepth.has(depth)) {
    let input = block;
    // Existing native charts keep their stored labels/values, units and revisions.
    if (block.type === 'chart' && Array.isArray(block.labels) && Array.isArray(block.series)) {
      const labels = block.labels;
      input = { ...block, title: typeof block.title === 'string' && block.title.trim() ? block.title : 'Chart', series: (block.series as Array<{ label: string; values: number[] }>).map((series) => ({ label: series.label, points: series.values.map((y, i) => ({ x: labels[i], y })) })) };
    }
    const desk = validateBlock(input, depth);
    byDepth.set(depth, desk && { ...desk, id: typeof block.id === 'string' ? block.id : desk.id });
  }
  return byDepth.get(depth) ?? null;
}

/**
 * One of Desk's renderers in Michi's registry. Its h2 gets an id of its own,
 * as Desk's block shell hands one down; a block the catalog will not read
 * falls back to `fallback`, Michi's one-line label.
 */
function fromDesk<K extends Type>(type: K, Render: DeskRenderer<K>, Fallback: BlockRenderer): BlockRenderer {
  function DeskDrawn({ block, ctx }: BlockProps) {
    const hid = useId();
    // Repeated native labels are positional, while the rich chart groups by label.
    if (type === 'chart' && Array.isArray(block.labels) && new Set(block.labels).size !== block.labels.length) return <NativeChartFallback block={block} ctx={ctx} />;
    if (type === 'gallery' && ctx.loadImages !== true) return <NativeGalleryFallback block={block} ctx={ctx} />;
    if (type === 'gallery' && Array.isArray(block.items) && block.items.some((item) => item && typeof item === 'object' && 'url' in item && typeof item.url === 'string' && !loadableImageUrl(item.url))) {
      return <NativeGalleryFallback block={block} ctx={{ ...ctx, loadImages: ctx.loadImages ?? true }} />;
    }
    const desk = asRichBlock(block, ctx.depth);
    if (!desk || desk.type !== type) return <Fallback block={block} ctx={ctx} />;
    // Gallery title belongs to native content; the vendor drawing only takes images.
    if (type === 'gallery' && Array.isArray(block.items) && desk.type === 'gallery' && desk.items.length !== block.items.length) return <NativeGalleryFallback block={block} ctx={ctx} />;
    return <MichiMantine><PageImagesContext.Provider value={ctx.loadImages === true}><div data-michi-block={type}>
      {type === 'gallery' && typeof block.title === 'string' && <h3 className="michi-doc-block-title">{block.title}</h3>}
      <Render block={desk as DeskBlockProps<K>['block']} ctx={ctx} hid={hid} />
      {type === 'chart' && typeof block.unit === 'string' && <span className="michi-doc-caption">{block.unit}</span>}
    </div></PageImagesContext.Provider></MichiMantine>;
  }
  DeskDrawn.displayName = `Desk(${type})`;
  return DeskDrawn;
}

/**
 * The block types Michi draws with Desk's own code (vendor-blocks/, see its
 * README) on Mantine, which a MichiMantine above them must provide. The
 * types Michi draws itself are not here.
 */
export function richRenderers(fallback: BlockRenderer): Array<[Type, BlockRenderer]> {
  const entries: Array<[Type, BlockRenderer]> = [
    ['chart', fromDesk('chart', ChartBlock, fallback)],
    ['gauge', fromDesk('gauge', GaugeBlock, fallback)],
    ['ring', fromDesk('ring', RingBlock, fallback)],
    ['rating', fromDesk('rating', RatingBlock, fallback)],
    ['leaderboard', fromDesk('leaderboard', LeaderboardBlock, fallback)],
    ['agenda', fromDesk('agenda', AgendaBlock, fallback)],
    ['calendar', fromDesk('calendar', CalendarBlock, fallback)],
    ['clocks', fromDesk('clocks', ClocksBlock, fallback)],
    ['countdown', fromDesk('countdown', CountdownBlock, fallback)],
    ['gantt', fromDesk('gantt', GanttBlock, fallback)],
    ['stepper', fromDesk('stepper', StepperBlock, fallback)],
    ['image', fromDesk('image', MEDIA_RENDERERS.image, fallback)],
    ['gallery', fromDesk('gallery', MEDIA_RENDERERS.gallery, fallback)],
    ['before-after', fromDesk('before-after', MEDIA_RENDERERS['before-after'], fallback)],
    ['carousel', fromDesk('carousel', MEDIA_RENDERERS.carousel, fallback)],
    ['video', fromDesk('video', MEDIA_RENDERERS.video, fallback)],
    ['audio', fromDesk('audio', MEDIA_RENDERERS.audio, fallback)],
    ['embed', fromDesk('embed', MEDIA_RENDERERS.embed, fallback)],
    ['file', fromDesk('file', MEDIA_RENDERERS.file, fallback)],
    ['person', fromDesk('person', MEDIA_RENDERERS.person, fallback)],
    ['place', fromDesk('place', MEDIA_RENDERERS.place, fallback)],
    ['actions', fromDesk('actions', ActionsBlock, fallback)],
    ['form', fromDesk('form', FormBlock, fallback)],
    ['poll', fromDesk('poll', PollBlock, fallback)],
    ['diff', fromDesk('diff', DiffBlock, fallback)],
    ['math', fromDesk('math', MathBlock, fallback)],
    ['mermaid', fromDesk('mermaid', MermaidBlock, fallback)],
    ['toc', fromDesk('toc', TocBlock, fallback)],
  ];
  return entries;
}
