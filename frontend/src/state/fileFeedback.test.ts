import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFileReadSnapshot, isFileFeedbackTargetValid, type FileFeedbackTarget } from './fileFeedback';
import type { ChatNodeState, Project } from './chatTypes';

declare const require: (id: string) => unknown;
const { createHash, webcrypto } = require('node:crypto') as {
  webcrypto: Crypto;
  createHash: (algorithm: string) => { update: (text: string, encoding: string) => { digest: (encoding: string) => string } };
};

const target: FileFeedbackTarget = { backendConnectionId: 'local', projectId: 'p', treeId: 't', nodeId: 'n' };
const project: Project = {
  id: 'p', name: 'W', chatIds: ['root', 'n', 'other'], createdAt: 1, activeTreeId: 't',
  trees: [{ id: 't', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }, { id: 't2', rootNodeId: 'other', createdAt: 1, lastActiveAt: 1 }],
  edges: [{ source: 'root', target: 'n' }],
};
const node = (nodeId: string): ChatNodeState => ({ nodeId, projectId: 'p', kind: 'chat', chatId: null, messages: [], followUps: [], status: 'idle' });
const nodes = { root: node('root'), n: node('n'), other: node('other') };
afterEach(() => vi.unstubAllGlobals());

describe('file read snapshots', () => {
  it('hashes all UTF8 text including CJK, emoji and line endings without normalization', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const content = '标题🙂\r\n' + '完整文本'.repeat(1000);
    const snapshot = await createFileReadSnapshot(content, { backendConnectionId: 'local', projectId: 'p', treeId: 't', resolvedFilePath: '/actual/a.md', size: 12, modifiedAt: 10 });
    expect(snapshot.contentHash).toBe(createHash('sha256').update(content, 'utf8').digest('hex'));
    expect(snapshot).toMatchObject({ hashKind: 'sha256-text-utf8', resolvedFilePath: '/actual/a.md', size: 12 });
    expect((await createFileReadSnapshot(content + 'x', snapshot)).contentHash).not.toBe(snapshot.contentHash);
  });
});

describe('file feedback destination validation', () => {
  it('uses fixed forest ownership even when active tree changes; streaming can queue', () => {
    expect(isFileFeedbackTargetValid(target, [{ ...project, activeTreeId: 't2' }], { ...nodes, n: { ...nodes.n, status: 'streaming' } })).toBe(true);
    expect(isFileFeedbackTargetValid({ ...target, treeId: 't2' }, [project], nodes)).toBe(false);
    expect(isFileFeedbackTargetValid({ ...target, nodeId: 'other' }, [project], nodes)).toBe(false);
  });
  it.each(['deleted', 'archived-tree', 'archived-workspace', 'backend', 'workspace', 'missing', 'non-chat', 'dead-root'])('rejects %s', failure => {
    const p = { ...project, trees: project.trees.map(t => ({ ...t })) };
    const ns = { ...nodes, n: { ...nodes.n }, root: { ...nodes.root } };
    if (failure === 'deleted') ns.n.deletedAt = 1;
    if (failure === 'archived-tree') p.trees[0].archivedAt = 1;
    if (failure === 'archived-workspace') p.archivedAt = 1;
    if (failure === 'backend') p.backendConnectionId = 'remote';
    if (failure === 'workspace') ns.n.projectId = 'elsewhere';
    if (failure === 'missing') delete (ns as Partial<typeof ns>).n;
    if (failure === 'non-chat') ns.n.kind = 'digest';
    if (failure === 'dead-root') ns.root.deletedAt = 1;
    expect(isFileFeedbackTargetValid(target, [p], ns)).toBe(false);
  });
});
