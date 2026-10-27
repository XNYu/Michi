import { pageBlockTitle, type PageBlock, type PageChangeDto } from 'michi-shared';
import { backendApiBase } from '../../config/backendConnections';
import { backendEntityId, serverEntityId } from '../../config/backendIdentity';
import { fetchPage, listPageChanges, pagesFetch, readPagesJson } from '../../services/api/pages';

export interface SourcePreview {
  nodeId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  runtimeId: string | null;
  state: 'live' | 'archived' | 'deleted';
  message: { id: string; role: string; text: string; truncated: boolean; turnId: string | null; at: number } | null;
}

/** `null`: the backend has no such conversation (purged, or never Michi's). */
export async function fetchSourcePreview(
  backendConnectionId: string,
  query: { nodeId?: string | null; messageId?: string | null },
  signal?: AbortSignal,
): Promise<SourcePreview | null> {
  const params = new URLSearchParams();
  if (query.nodeId) params.set('nodeId', serverEntityId(query.nodeId, backendConnectionId));
  if (query.messageId) params.set('messageId', query.messageId);
  const response = await pagesFetch(`${backendApiBase(backendConnectionId)}/spaces-home/source?${params}`, { signal });
  if (!response.ok) {
    // A backend without this route answers 404 too; only its own not_found means the conversation is gone.
    const payload = await readPagesJson(response).catch(() => null) as { error?: { code?: unknown } } | null;
    if (response.status === 404 && payload?.error?.code === 'not_found') return null;
    throw new Error(`Source request failed (${response.status})`);
  }
  const body = await readPagesJson(response) as SourcePreview;
  return {
    ...body,
    nodeId: backendEntityId(backendConnectionId, body.nodeId),
    workspaceId: backendEntityId(backendConnectionId, body.workspaceId),
  };
}

const HEADING = /^#{1,6}\s+(.+)$/;

function shortText(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 16 ? `${line.slice(0, 16)}…` : line;
}

/** What a reader calls a block: its title or heading, else the heading above it, else its first words. */
export function blockName(block: PageBlock, blocks: readonly PageBlock[]): string {
  if (block.type === 'heading') return block.text.trim();
  if ((block.type === 'callout' || block.type === 'checklist') && block.title?.trim()) return block.title.trim();
  if (block.type === 'markdown' || block.type === 'callout') {
    const first = block.text.trim().split('\n')[0] ?? '';
    const heading = HEADING.exec(first);
    if (heading) return heading[1].trim();
  } else {
    // A chart, a comparison or a conflict is called by its own title or question.
    const own = pageBlockTitle(block);
    if (own) return own;
  }
  for (let i = blocks.indexOf(block) - 1; i >= 0; i -= 1) {
    const above = blocks[i];
    if (above.type === 'heading') return above.text.trim();
  }
  if (block.type === 'markdown' || block.type === 'callout') return shortText(block.text);
  return '';
}

/** Whether a change cites the message: its chat reply, or a maintenance evidence entry's message (the user message when it names one). */
export function citesMessage(change: PageChangeDto, messageId: string): boolean {
  const source = change.source;
  if (source.kind === 'chat' || source.kind === 'helper') return source.assistantId === messageId;
  if (source.kind === 'maintenance') return source.evidence.some((item) => (item.messageId ?? item.assistantId) === messageId);
  return false;
}

/** The blocks of a page whose changes cite this message, in page order, joined as the mock writes them. */
export async function describePageReference(
  page: { backendConnectionId: string; workspaceId: string; pageId: string },
  messageId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const options = { backendConnectionId: page.backendConnectionId, workspaceId: page.workspaceId, signal };
  const [doc, changes] = await Promise.all([
    fetchPage(page.pageId, options),
    listPageChanges(page.pageId, { ...options, direction: 'backward', limit: 100 }),
  ]);
  if (!doc) return null;
  const cited = new Set(changes.changes.filter((change) => change.target.kind === 'block' && citesMessage(change, messageId))
    .map((change) => (change.target as { blockId: string }).blockId));
  const names = doc.blocks.filter((block) => cited.has(block.id)).map((block) => blockName(block, doc.blocks)).filter(Boolean);
  return names.length ? [...new Set(names)].join(', ') : null;
}
