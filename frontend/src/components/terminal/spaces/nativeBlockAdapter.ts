import type { MichiPageBlock } from 'michi-shared';
import { parsePageBlockInput, withoutStalePageSegmentSources } from 'michi-shared';
import type { PageDto, PageEditOp, PageBlock } from 'michi-shared';
import type { MichiPageEditOp } from '../content/page/editorTypes';

/**
 * Makes a renderer-only Michi-shaped view of a native block. The caller keeps
 * the original PageBlock as the authority for revision, ownership and source.
 */
export function toMichiBlock(block: PageBlock): MichiPageBlock {
  const { id, rev: _rev, sources: _sources, edit, ...content } = block;
  return withChildIds({ ...content, id, ...(edit ? { edit: { at: edit.at } } : {}) });
}

function withChildIds(block: MichiPageBlock): MichiPageBlock {
  let index = 0;
  const slot = (blocks: unknown) => (blocks as MichiPageBlock[]).map((child) => withChildIds({ ...child, id: `${block.id}.${index++}` }));
  if (block.type === 'toggle') return { ...block, blocks: slot(block.blocks) };
  if (block.type === 'columns') return { ...block, columns: (block.columns as unknown[]).map(slot) };
  if (block.type === 'tabs') return { ...block, tabs: (block.tabs as Array<{ label: string; blocks: unknown }>).map((tab) => ({ ...tab, blocks: slot(tab.blocks) })) };
  if (block.type === 'grid') return { ...block, regions: (block.regions as Array<{ id: string; blocks: MichiPageBlock[] }>).map((region) => ({ ...region,
    blocks: region.blocks.map((child, at) => withChildIds({ ...child, id: `${block.id}.grid.${Array.from(region.id, (char) => char.codePointAt(0)!.toString(16)).join('-')}.${at}` })),
  })) };
  return block;
}

/** Renderer identities inside atomic containers are view state, never server metadata. */
export function contentOnly(block: MichiPageBlock | PageBlock): Record<string, unknown> {
  const { id: _id, rev: _rev, sources: _sources, edit: _edit, ...content } = block;
  const slot = (blocks: unknown) => (blocks as MichiPageBlock[]).map(contentOnly);
  if (block.type === 'toggle') return { ...content, blocks: slot(block.blocks) };
  if (block.type === 'columns') return { ...content, columns: (block.columns as unknown[]).map(slot) };
  if (block.type === 'tabs') return { ...content, tabs: (block.tabs as Array<{ label: string; blocks: unknown }>).map((tab) => ({ ...tab, blocks: slot(tab.blocks) })) };
  if (block.type === 'grid') return { ...content, regions: (block.regions as Array<{ id: string; blocks: unknown }>).map((region) => ({ ...region, blocks: slot(region.blocks) })) };
  return content;
}

/**
 * Convert the old chrome's familiar edit vocabulary to the closed native
 * operation contract. Native block metadata is read from `page`, never sent
 * back through the renderer-shaped block.
 */
export function toNativePageOps(ops: readonly MichiPageEditOp[], page: PageDto): PageEditOp[] | null {
  const converted: PageEditOp[] = [];
  for (const op of ops) {
    if (op.op === 'insert') {
      const parsed = parsePageBlockInput(op.block);
      if (!parsed) return null;
      converted.push({ op: 'insert', block: parsed, after: op.after ?? null });
      continue;
    }
    const id = 'id' in op ? op.id : null;
    if (!id) return null;
    const current = page.blocks.find((block) => block.id === id);
    if (!current) return null;
    if (op.op === 'update') {
      if (op.block.type !== current.type) return null;
      const content = parsePageBlockInput(withoutStalePageSegmentSources(contentOnly(op.block)));
      if (!content || content.type !== current.type) return null;
      converted.push({ op: 'update', id, block: content, expectRev: current.rev });
    } else if (op.op === 'delete') {
      converted.push({ op: 'delete', id, expectRev: current.rev });
    } else if (op.op === 'move') {
      converted.push({ op: 'move', id, after: op.after ?? null, expectRev: current.rev });
    } else if (op.op === 'release') {
      converted.push({ op: 'release', id, expectRev: current.rev });
    } else {
      return null;
    }
  }
  return converted;
}
