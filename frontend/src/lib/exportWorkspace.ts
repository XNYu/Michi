import { ExportRequestPayload } from '../services/api';
import { getElectron } from './electronBridge';
import { descendants } from '../state/tree';
import { ChatNodeState, Project } from '../state/chatStore';
import { visibleMessageText } from '../state/assistantBlocks';
import type { ChatMessage } from '../state/chatTypes';

/** Filter a node's messages down to user/assistant pairs suitable for export. */
function serializeMessages(n: ChatNodeState): Array<{ role: 'user' | 'assistant'; text: string }> {
  return n.messages
    .map((m) => ({
      role: m.role,
      text: messageTextForExport(m),
    }))
    .filter((m) => !!m.text);
}

function blockQuote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
}

function userMessageTextForExport(m: ChatMessage): string {
  const parts: string[] = [];
  if (m.quotedText?.trim()) {
    parts.push(`_Quoted selection:_\n\n${blockQuote(m.quotedText.trim())}`);
  }
  if (m.attachments && m.attachments.length > 0) {
    parts.push([
      '_Attachments:_',
      ...m.attachments.map((a) => `- ${a.name}${a.absPath ? ` (${a.absPath})` : ''}`),
    ].join('\n'));
  }
  if (m.comments && m.comments.length > 0) {
    const comments = m.comments.map((c, index) => {
      const body = c.body.trim();
      const quoted = c.quotedText.trim();
      return [
        `${index + 1}. ${body || '(empty comment)'}`,
        quoted ? blockQuote(quoted) : '',
      ].filter(Boolean).join('\n\n');
    });
    parts.push(['_Comments on previous reply:_', ...comments].join('\n\n'));
  }
  if (m.text.trim()) parts.push(m.text);
  return parts.join('\n\n').trim();
}

function messageTextForExport(m: ChatMessage): string {
  return m.role === 'assistant' ? visibleMessageText(m) : userMessageTextForExport(m);
}

/** Compute node depth in the subtree starting from rootId. */
function computeDepths(
  rootId: string,
  edges: Array<{ source: string; target: string; kind?: 'branch' | 'merge' | 'link' | 'digest-source' }>,
): Map<string, number> {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    // Only follow real parent→child (branch) edges for depth. Merge and
    // link edges are cross-references, not tree structure.
    if (e.kind !== undefined && e.kind !== 'branch') continue;
    const arr = childrenOf.get(e.source) ?? [];
    arr.push(e.target);
    childrenOf.set(e.source, arr);
  }
  const depths = new Map<string, number>();
  const stack: Array<{ id: string; depth: number }> = [{ id: rootId, depth: 0 }];
  while (stack.length > 0) {
    const { id, depth } = stack.pop()!;
    if (depths.has(id)) continue;
    depths.set(id, depth);
    const kids = childrenOf.get(id) ?? [];
    for (const k of kids) stack.push({ id: k, depth: depth + 1 });
  }
  return depths;
}

export function buildExportPayload(
  project: Project,
  rootNodeId: string,
  nodes: Record<string, ChatNodeState>,
): ExportRequestPayload {
  const alive = (id: string) => !nodes[id]?.deletedAt;
  const included = descendants(rootNodeId, project.edges, alive);
  included.add(rootNodeId);
  const depths = computeDepths(rootNodeId, project.edges);
  const rootNode = nodes[rootNodeId];
  const rootTitle = rootNode?.title
    ?? rootNode?.messages.find((m) => m.role === 'user')?.text.slice(0, 80)
    ?? project.name;
  const nodeList: ExportRequestPayload['nodes'] = [];
  for (const id of Array.from(included)) {
    const n = nodes[id];
    if (!n) continue;
    nodeList.push({
      nodeId: n.nodeId,
      parentNodeId: n.parentNodeId,
      title: n.title,
      depth: depths.get(id) ?? 0,
      messages: serializeMessages(n),
    });
  }
  // Sort by depth then by parent-then-child so the backend sees a sane order.
  nodeList.sort((a, b) => a.depth - b.depth);
  return {
    workspace: { name: project.name, cwd: project.cwd, createdAt: project.createdAt },
    rootTitle,
    nodes: nodeList,
    cwd: project.cwd,
  };
}

function oneLine(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function nodeLabel(n: ChatNodeState | undefined, fallback = 'Untitled'): string {
  return oneLine(n?.title)
    || oneLine(n?.messages.find((m) => m.role === 'user')?.text).slice(0, 80)
    || fallback;
}

function formatTimestamp(ms: number | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function selectedPayloadNodes(payload: ExportRequestPayload, nodeIds?: string[]) {
  if (!nodeIds || nodeIds.length === 0) return payload.nodes;
  const selected = new Set(nodeIds);
  return payload.nodes.filter((n) => selected.has(n.nodeId));
}

export function buildTranscriptMarkdown(
  project: Project,
  rootNodeId: string,
  nodes: Record<string, ChatNodeState>,
  nodeIds?: string[],
): string {
  const payload = buildExportPayload(project, rootNodeId, nodes);
  const nodeList = selectedPayloadNodes(payload, nodeIds);
  if (nodeList.length === 0) throw new Error('No nodes to export.');

  const rootTitle = payload.rootTitle || project.name;
  const lines: string[] = [
    `# ${rootTitle}`,
    '',
    `Workspace: ${project.name}`,
    `Exported: ${new Date().toISOString()}`,
  ];
  if (project.cwd) lines.push(`Folder: ${project.cwd}`);
  lines.push('', '## Tree', '');

  for (const entry of nodeList) {
    const label = nodeLabel(nodes[entry.nodeId], entry.title || 'Untitled');
    lines.push(`${'  '.repeat(Math.max(0, entry.depth))}- ${label}`);
  }

  lines.push('', '## Transcript', '');

  for (const entry of nodeList) {
    const node = nodes[entry.nodeId];
    if (!node) continue;
    const level = Math.min(2 + Math.max(0, entry.depth), 6);
    const label = nodeLabel(node, entry.title || 'Untitled');
    lines.push(`${'#'.repeat(level)} ${label}`, '');
    if (entry.parentNodeId) {
      const parent = nodes[entry.parentNodeId];
      lines.push(`_Branched from: ${nodeLabel(parent, 'root')}_`, '');
    }
    const messages = node.messages
      .map((m) => ({ message: m, text: messageTextForExport(m).trim() }))
      .filter((m) => m.text);
    if (messages.length === 0) {
      lines.push('_No messages._', '');
      continue;
    }
    messages.forEach(({ message, text }, index) => {
      const role = message.role === 'user' ? 'User' : 'Assistant';
      const when = formatTimestamp(message.createdAt);
      lines.push(when ? `**${role}** _${when}_` : `**${role}**`, '', text);
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length > 0) {
        lines.push(
          '',
          `_Tool calls:_ ${toolCalls.map((t) => `${t.title} (${t.status})`).join(', ')}`,
        );
      }
      lines.push('');
      if (index < messages.length - 1) lines.push('---', '');
    });
  }

  return lines.join('\n').trim() + '\n';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workspace';
}

export function defaultExportFilename(title: string): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${slugify(title)}-${yyyy}-${mm}-${dd}.md`;
}

/** Trigger the browser/Electron save flow. Returns true if saved, false if user cancelled. */
export async function saveMarkdown(suggestedName: string, content: string): Promise<boolean> {
  const electron = getElectron();
  if (electron) {
    const r = await electron.saveMarkdown(suggestedName, content);
    return !r.canceled;
  }
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

/** Generate a faithful Markdown transcript locally. No model call. */
export function runTranscript(
  project: Project,
  rootNodeId: string,
  nodes: Record<string, ChatNodeState>,
): { markdown: string; suggestedFilename: string } {
  const markdown = buildTranscriptMarkdown(project, rootNodeId, nodes);
  const payload = buildExportPayload(project, rootNodeId, nodes);
  const suggestedFilename = defaultExportFilename(payload.rootTitle || project.name);
  return { markdown, suggestedFilename };
}

/** Generate a faithful Markdown transcript for a selected subset. No model call. */
export function runSelectionTranscript(
  project: Project,
  rootNodeId: string,
  nodes: Record<string, ChatNodeState>,
  nodeIds: string[],
): { markdown: string; suggestedFilename: string } {
  const markdown = buildTranscriptMarkdown(project, rootNodeId, nodes, nodeIds);
  const payload = buildExportPayload(project, rootNodeId, nodes);
  const suggestedFilename = defaultExportFilename(`${payload.rootTitle || project.name}-selection`);
  return { markdown, suggestedFilename };
}

