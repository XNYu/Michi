import type { BlockSource, PageBlockContent } from './blocks';

/** Native Pages and its writer use the same boundaries, including nested list content. */
export interface PageMarkdownSegment {
  index: number;
  kind: 'heading' | 'paragraph' | 'list-item' | 'code' | 'table' | 'quote';
  text: string;
}

/** An exact text anchor prevents a changed or reordered item from inheriting another item's evidence. */
export interface PageSegmentSources { text: string; sources: BlockSource[] }

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const ITEM = /^ {0,3}([-*+]|\d+[.)])\s/;
const TABLE = /^ {0,3}\|/;
const QUOTE = /^ {0,3}>/;
const opensFence = (line: string) => {
  const match = FENCE.exec(line);
  return match && !(match[1][0] === '`' && match[2].includes('`')) ? match[1] : null;
};
function fenceEnd(lines: string[], from: number, fence: string): number {
  for (let at = from + 1; at < lines.length; at++) {
    const line = lines[at].trim();
    if (line.length >= fence.length && line === fence[0].repeat(line.length)) return at + 1;
  }
  return lines.length;
}
function indentation(line: string): number {
  let count = 0;
  for (const char of line) { if (char === ' ') count++; else if (char === '\t') count += 4; else break; }
  return count;
}
function itemEnd(lines: string[], from: number): number {
  const needed = indentation(lines[from]) + 2;
  let end = from + 1;
  for (let at = from + 1; at < lines.length; at++) {
    if (!lines[at].trim()) continue;
    if (indentation(lines[at]) < needed) break;
    const fence = opensFence(lines[at].trimStart());
    if (fence) at = fenceEnd(lines, at, fence) - 1;
    end = at + 1;
  }
  return end;
}
const startsBlock = (line: string) => opensFence(line) !== null || HEADING.test(line) || ITEM.test(line) || TABLE.test(line) || QUOTE.test(line);

/** A heading, paragraph, top-level list item, fenced block, table or quote is one segment. */
export function splitPageMarkdown(text: string): PageMarkdownSegment[] {
  const lines = text.split(/\r?\n/);
  const result: PageMarkdownSegment[] = [];
  const push = (kind: PageMarkdownSegment['kind'], from: number, to: number) => {
    let end = to;
    while (end > from && !lines[end - 1].trim()) end--;
    result.push({ index: result.length, kind, text: lines.slice(from, end).join('\n') });
  };
  for (let at = 0; at < lines.length;) {
    const line = lines[at];
    if (!line.trim()) { at++; continue; }
    const fence = opensFence(line);
    if (fence) { const end = fenceEnd(lines, at, fence); push('code', at, end); at = end; continue; }
    if (HEADING.test(line)) { push('heading', at, at + 1); at++; continue; }
    if (ITEM.test(line)) { const end = itemEnd(lines, at); push('list-item', at, end); at = end; continue; }
    const run = TABLE.test(line) ? TABLE : QUOTE.test(line) ? QUOTE : null;
    if (run) { let end = at + 1; while (end < lines.length && run.test(lines[end])) end++; push(run === TABLE ? 'table' : 'quote', at, end); at = end; continue; }
    let end = at + 1;
    while (end < lines.length && lines[end].trim() && !startsBlock(lines[end])) end++;
    push('paragraph', at, end); at = end;
  }
  return result;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Reject mismatches rather than guessing which passage an old citation belonged to. */
export function parsePageSegmentSources(text: string, value: unknown): PageSegmentSources[] | null {
  const segments = splitPageMarkdown(text);
  if (!Array.isArray(value) || value.length !== segments.length || value.length > 100) return null;
  const parsed: PageSegmentSources[] = [];
  let sourcesCount = 0;
  for (let index = 0; index < value.length; index++) {
    const entry: unknown = value[index];
    if (!record(entry) || Object.keys(entry).some(key => key !== 'text' && key !== 'sources') || entry.text !== segments[index].text || !Array.isArray(entry.sources)) return null;
    const sources: BlockSource[] = [];
    sourcesCount += entry.sources.length;
    if (sourcesCount > 100) return null;
    for (const candidate of entry.sources) {
      if (!record(candidate) || Object.keys(candidate).some(key => !['nodeId', 'turnId', 'assistantId'].includes(key)) ||
        !id(candidate.nodeId) || !id(candidate.turnId) || !id(candidate.assistantId)) return null;
      sources.push({ nodeId: candidate.nodeId, turnId: candidate.turnId, assistantId: candidate.assistantId });
    }
    parsed.push({ text: entry.text as string, sources });
  }
  return parsed;
}

/** Renderer edits replace words; citations survive only if every exact anchor still matches. */
export function withoutStalePageSegmentSources(value: Record<string, unknown>): Record<string, unknown> {
  if (value.type === 'markdown' && value.segmentSources !== undefined &&
    (typeof value.text !== 'string' || !parsePageSegmentSources(value.text, value.segmentSources))) {
    const { segmentSources: _stale, ...rest } = value;
    return rest;
  }
  const slot = (blocks: unknown) => Array.isArray(blocks) ? blocks.map(block => record(block) ? withoutStalePageSegmentSources(block) : block) : blocks;
  if (value.type === 'toggle') return { ...value, blocks: slot(value.blocks) };
  if (value.type === 'columns' && Array.isArray(value.columns)) return { ...value, columns: value.columns.map(slot) };
  if (value.type === 'tabs' && Array.isArray(value.tabs)) return { ...value, tabs: value.tabs.map(tab => record(tab) ? { ...tab, blocks: slot(tab.blocks) } : tab) };
  if (value.type === 'grid' && Array.isArray(value.regions)) return { ...value, regions: value.regions.map(region => record(region) ? { ...region, blocks: slot(region.blocks) } : region) };
  return value;
}

/** Every citation in a native atomic container, with no view-only child identity required. */
export function pageSegmentSources(block: PageBlockContent): BlockSource[] {
  if (block.type === 'markdown') return block.segmentSources?.flatMap(segment => segment.sources) ?? [];
  if (block.type === 'toggle') return block.blocks.flatMap(pageSegmentSources);
  if (block.type === 'columns') return block.columns.flatMap(column => column.flatMap(pageSegmentSources));
  if (block.type === 'tabs') return block.tabs.flatMap(tab => tab.blocks.flatMap(pageSegmentSources));
  if (block.type === 'grid') return block.regions.flatMap(region => region.blocks.flatMap(pageSegmentSources));
  return [];
}

export function uniquePageSources(sources: readonly BlockSource[]): BlockSource[] {
  return [...new Map(sources.map(source => [JSON.stringify([source.nodeId, source.turnId, source.assistantId]), source])).values()];
}

/** A human may retain evidence already attached to unchanged words, but cannot invent agent provenance. */
export function retainUserPageSegmentSources(content: PageBlockContent, previous?: PageBlockContent): PageBlockContent {
  if (content.type === 'markdown') {
    const { segmentSources: _supplied, ...text } = content;
    return previous?.type === 'markdown' && previous.text === content.text && previous.segmentSources
      ? { ...text, segmentSources: previous.segmentSources } : text;
  }
  if (content.type === 'toggle') return { ...content, blocks: content.blocks.map((block, index) => retainUserPageSegmentSources(block, previous?.type === 'toggle' ? previous.blocks[index] : undefined)) as typeof content.blocks };
  if (content.type === 'columns') return { ...content, columns: content.columns.map((column, index) => column.map((block, child) => retainUserPageSegmentSources(block, previous?.type === 'columns' ? previous.columns[index]?.[child] : undefined)) as typeof column) };
  if (content.type === 'tabs') return { ...content, tabs: content.tabs.map((tab, index) => ({ ...tab, blocks: tab.blocks.map((block, child) => retainUserPageSegmentSources(block, previous?.type === 'tabs' ? previous.tabs[index]?.blocks[child] : undefined)) as typeof tab.blocks })) };
  if (content.type === 'grid') return { ...content, regions: content.regions.map(region => {
    const prior = previous?.type === 'grid' ? previous.regions.find(candidate => candidate.id === region.id) : undefined;
    return { ...region, blocks: region.blocks.map((block, child) => retainUserPageSegmentSources(block, prior?.blocks[child])) as typeof region.blocks };
  }) };
  return content;
}
