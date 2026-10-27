import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, SlidersHorizontal } from 'lucide-react';
import type { MichiPageBlock } from 'michi-shared';
import type { BlockProps } from '../blockTypes';
import { blocksOf, objects, str } from '../michiPageModel';
import './grid.css';

export interface GridRegion {
  id: string;
  span: number;
  tabletSpan?: number;
  title?: string;
  blocks: MichiPageBlock[];
}

const boundedSpan = (value: unknown, fallback = 12) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 12 ? value : fallback;
const regionsOf = (block: MichiPageBlock): GridRegion[] => objects(block.regions).map((region) => ({
  id: str(region.id), span: boundedSpan(region.span),
  ...(region.tabletSpan === undefined ? {} : { tabletSpan: boundedSpan(region.tabletSpan) }),
  ...(typeof region.title === 'string' ? { title: region.title } : {}), blocks: blocksOf(region.blocks),
}));
const widths = Array.from({ length: 12 }, (_, index) => index + 1);

/** Layout is saved through the owning native block, preserving its nested content and revision checks. */
export function ResponsiveGrid({ block, ctx, renderRegion }: BlockProps & {
  renderRegion(region: GridRegion, replace: (blocks: MichiPageBlock[]) => MichiPageBlock): React.ReactNode;
}) {
  const [arranging, setArranging] = useState(false);
  const [preview, setPreview] = useState<{ id: string; span: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const regions = regionsOf(block);
  const latest = useRef({ block, ctx, regions });
  latest.current = { block, ctx, regions };
  useEffect(() => () => cleanup.current?.(), []);

  const save = (next: GridRegion[]) => ctx.updateBlock?.(block, { ...block, regions: next });
  const move = (index: number, direction: -1 | 1) => {
    if (index + direction < 0 || index + direction >= regions.length) return;
    const next = [...regions];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    save(next);
  };

  const resize = (event: React.PointerEvent<HTMLButtonElement>, region: GridRegion) => {
    if (!ctx.updateBlock || event.button !== 0 || !gridRef.current) return;
    const grid = gridRef.current;
    const gap = Number.parseFloat(window.getComputedStyle(grid).columnGap) || 0;
    const unit = (grid.getBoundingClientRect().width + gap) / 12;
    if (unit <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    cleanup.current?.();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const start = event.clientX;
    let span = region.span;
    handle.setPointerCapture?.(pointer);
    setPreview({ id: region.id, span });
    const change = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      span = Math.max(1, Math.min(12, region.span + Math.round((next.clientX - start) / unit)));
      setPreview({ id: region.id, span });
    };
    function remove() {
      handle.removeEventListener('pointermove', change);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', cancel);
      handle.removeEventListener('lostpointercapture', cancel);
      if (handle.hasPointerCapture?.(pointer)) handle.releasePointerCapture(pointer);
      cleanup.current = null;
    }
    function cancel(next: PointerEvent) {
      if (next.pointerId !== pointer) return;
      remove();
      setPreview(null);
    }
    function end(next: PointerEvent) {
      if (next.pointerId !== pointer) return;
      change(next);
      remove();
      setPreview(null);
      const current = latest.current;
      const target = current.regions.find((candidate) => candidate.id === region.id);
      // A live page update may have changed content while resizing. Keep that
      // content and reject a conflicting width change instead of restoring an old snapshot.
      if (!current.ctx.updateBlock || !target || target.span !== region.span || span === target.span) return;
      current.ctx.updateBlock(current.block, { ...current.block, regions: current.regions.map((candidate) => candidate.id === region.id ? { ...candidate, span } : candidate) });
    }
    cleanup.current = remove;
    handle.addEventListener('pointermove', change);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
  };

  return <div className="michi-doc-grid-container" data-michi-block="grid">
    <div ref={gridRef} className="michi-doc-grid" data-arranging={arranging && !!ctx.updateBlock || undefined}>
      {regions.map((region, index) => {
        const name = region.title?.trim() || `Region ${index + 1}`;
        const span = preview?.id === region.id ? preview.span : region.span;
        return <section key={region.id} className="michi-doc-grid__region" data-region-id={region.id} aria-label={name}
          style={{ '--grid-span': span, '--grid-tablet-span': region.tabletSpan ?? 12 } as React.CSSProperties}>
          {region.title && <h3 className="michi-doc-grid__title">{region.title}</h3>}
          {arranging && ctx.updateBlock && <div className="michi-doc-grid__controls" data-block-chrome="">
            <button type="button" aria-label={`Move ${name} earlier`} title="Move region earlier" disabled={index === 0 || !!preview} onClick={() => move(index, -1)}><ArrowLeft size={14} /></button>
            <button type="button" aria-label={`Move ${name} later`} title="Move region later" disabled={index === regions.length - 1 || !!preview} onClick={() => move(index, 1)}><ArrowRight size={14} /></button>
            <label>Width<select aria-label={`${name} width`} value={span} disabled={!!preview} onChange={(event) => save(regions.map((candidate) => candidate.id === region.id ? { ...candidate, span: Number(event.target.value) } : candidate))}>
              {widths.map((width) => <option key={width} value={width}>{width}/12</option>)}
            </select></label>
            <label>Medium width<select aria-label={`${name} medium width`} value={region.tabletSpan ?? 12} disabled={!!preview} onChange={(event) => save(regions.map((candidate) => candidate.id === region.id ? { ...candidate, tabletSpan: Number(event.target.value) } : candidate))}>
              {widths.map((width) => <option key={width} value={width}>{width}/12</option>)}
            </select></label>
          </div>}
          {renderRegion(region, (blocks) => ({ ...block, regions: regions.map((candidate) => candidate.id === region.id ? { ...candidate, blocks } : candidate) }))}
          {arranging && ctx.updateBlock && <button type="button" className="michi-doc-grid__resize" tabIndex={-1} aria-label={`Drag to resize ${name}`} title="Drag to resize region" onPointerDown={(event) => resize(event, region)} />}
        </section>;
      })}
    </div>
    {ctx.updateBlock && <div className="michi-doc-grid__tools" data-block-chrome="">
      <button type="button" aria-pressed={arranging} onClick={() => { cleanup.current?.(); setPreview(null); setArranging(!arranging); }}>
        <SlidersHorizontal size={14} />{arranging ? 'Done arranging' : 'Arrange layout'}
      </button>
    </div>}
  </div>;
}
