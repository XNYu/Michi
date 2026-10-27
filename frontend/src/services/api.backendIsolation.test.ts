import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backendEntityId, backendRequestUrl, mapBackendPayload } from '../config/backendIdentity';
import { backendApiBase, indexBackendProjects, nodeBackendApiBase, workspaceBackendApiBase } from '../config/backendConnections';
import { backendFetch, backendStreamResponse } from './api/backendRequest';
import { backendConnectionGeneration, backendConnectionUnavailable, markBackendConnectionReady, markBackendConnectionUnavailable } from '../config/backendConnectionState';
import { hydrateBackendWorkspaces } from '../state/chatHydration';
import { importWorkspaceFile } from './api/uploads';

import { fetchStream } from './api/streamTransport';

describe('remote connection data isolation', () => {
  const connectionId = 'remote-isolation';
  const workspaceId = backendEntityId(connectionId, 'ws');
  const nodeId = backendEntityId(connectionId, 'n1');
  const base = backendApiBase(connectionId);
  beforeEach(() => { markBackendConnectionReady(connectionId); indexBackendProjects([]); });
  afterEach(() => { vi.unstubAllGlobals(); markBackendConnectionReady(connectionId); });

  it('routes a detached remote identity to its own server and never needs a Local registration', async () => {
    const fetch = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ workspace: { id: 'ws' }, nodes: [{ id: 'n1', workspace_id: 'ws', acp_session_id: 'n1' }] })));
    vi.stubGlobal('fetch', fetch);
    expect(nodeBackendApiBase(nodeId)).toBe(base);
    const response = await backendFetch(`${workspaceBackendApiBase(workspaceId)}/workspaces/${encodeURIComponent(workspaceId)}`);
    expect(fetch.mock.calls[0][0]).toBe(`${base}/workspaces/ws`);
    const data = await response.json();
    expect(data.workspace.id).toBe(workspaceId);
    expect(data.nodes[0]).toEqual({ id: nodeId, workspace_id: workspaceId, acp_session_id: 'n1' });
    const hydrated = hydrateBackendWorkspaces([data], null, connectionId);
    expect(hydrated.nodes[nodeId].runtimeId).toBe('pi');
  });

  it('rejects a late snapshot and blocks writes after the owning connection disconnects', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const pending = backendFetch(`${base}/workspaces/all?meta=1`);
    markBackendConnectionUnavailable(connectionId);
    resolve(new Response(JSON.stringify({ workspaces: [] })));
    await expect((await pending).json()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(backendFetch(`${base}/workspaces/ws/commands`, { method: 'POST', body: '{}' })).rejects.toThrow('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('converts pane and move references while leaving search text and native sessions opaque', () => {
    const raw = { fromWorkspaceId: 'ws', toWorkspaceId: 'target', sourceWorkspaceId: 'ws',
      views: [{ paneId: 'node:n1', target: { kind: 'node', nodeId: 'n1' } }], paneIds: ['node:n1', 'surface:browser'],
      acp_session_id: 'n1', sessionId: 'n1' };
    const mapped = mapBackendPayload(raw, connectionId, 'renderer');
    expect(mapped.views[0]).toEqual({ paneId: `node:${nodeId}`, target: { kind: 'node', nodeId } });
    expect(mapped.toWorkspaceId).toBe(backendEntityId(connectionId, 'target'));
    expect(mapBackendPayload(mapped, connectionId, 'server')).toEqual(raw);
    const url = new URL(backendRequestUrl(`${base}/panes/output?${new URLSearchParams({
      paneId: `node:${nodeId}`, executionRef: JSON.stringify({ kind: 'chat_turn', nodeId, turnId: 'turn' }), q: nodeId,
    })}`));
    expect(url.searchParams.get('paneId')).toBe('node:n1');
    expect(JSON.parse(url.searchParams.get('executionRef')!)).toEqual({ kind: 'chat_turn', nodeId: 'n1', turnId: 'turn' });
    expect(url.searchParams.get('q')).toBe(nodeId);
    expect(() => mapBackendPayload({ fromWorkspaceId: workspaceId, toWorkspaceId: backendEntityId('other', 'ws') }, connectionId, 'server')).toThrow('different backend');
  });

  it('converts upload bodies even when upload progress uses XMLHttpRequest', async () => {
    const sent: { url?: string; body?: string } = {};
    vi.stubGlobal('XMLHttpRequest', class {
      upload = {};
      status = 200;
      responseText = JSON.stringify({ name: 'note.txt', filePath: '/srv/note.txt', size: 3 });
      onload!: () => void;
      open(_method: string, url: string) { sent.url = url; }
      setRequestHeader() {}
      send(body: string) { sent.body = body; this.onload(); }
    });
    await importWorkspaceFile(workspaceId, '/srv', 'note.txt', 'abc', { onProgress: vi.fn() });
    expect(sent.url).toBe(`${base}/workspaces/import-file`);
    expect(JSON.parse(sent.body!)).toMatchObject({ workspaceId: 'ws', cwd: '/srv', content: 'abc' });
  });

  it('rejects stream headers from a previous connection generation', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const pending = fetchStream(`${base}/chats/${encodeURIComponent(nodeId)}/stream`);
    markBackendConnectionUnavailable(connectionId);
    markBackendConnectionReady(connectionId);
    resolve(new Response('event: chunk\ndata: {"nodeId":"n1","text":"late"}\n\n'));
    await expect((await pending).text()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('marks a broken stream unavailable but preserves intentional observer cancellation', async () => {
    const brokenStream = () => new Response(new ReadableStream({ pull() { throw new TypeError('socket closed'); } }));
    await expect(backendStreamResponse(brokenStream(), connectionId).text()).rejects.toThrow('socket closed');
    expect(backendConnectionUnavailable(connectionId)).toBe(true);
    markBackendConnectionReady(connectionId);
    const controller = new AbortController();
    controller.abort();
    await expect(backendStreamResponse(brokenStream(), connectionId, backendConnectionGeneration(connectionId), controller.signal).text()).rejects.toThrow();
    expect(backendConnectionUnavailable(connectionId)).toBe(false);
  });

  it('scopes trees, trim restoration and per-window draft references alongside workspace and node identities', () => {
    const trim = JSON.stringify({ parentId: 'parent', childrenIds: ['child'], wasTreeRoot: { treeId: 'tree' } });
    const draft = JSON.stringify({ value: 'mention', mentions: [{ kind: 'node', refId: 'child' }] });
    const raw = { workspace: { id: 'ws', active_tree_id: 'tree' }, trees: [{ id: 'tree', root_node_id: 'parent' }],
      nodes: [{ id: 'child', tree_id: 'tree', trim_snapshot: trim, composer_draft: JSON.stringify({ __michiWindowDrafts: { window: draft } }) }],
      metadata: JSON.stringify({ threadMessage: { fromNodeId: 'parent', fromTitle: 'Parent' } }) };
    const mapped = mapBackendPayload(raw, connectionId, 'renderer');
    const treeId = backendEntityId(connectionId, 'tree');
    expect(mapped.trees[0].id).toBe(treeId);
    expect(mapped.workspace.active_tree_id).toBe(treeId);
    expect(mapped.nodes[0].tree_id).toBe(treeId);
    expect(JSON.parse(mapped.nodes[0].trim_snapshot)).toEqual({ parentId: backendEntityId(connectionId, 'parent'),
      childrenIds: [backendEntityId(connectionId, 'child')], wasTreeRoot: { treeId } });
    const windowDraft = JSON.parse(JSON.parse(mapped.nodes[0].composer_draft).__michiWindowDrafts.window);
    expect(windowDraft.mentions[0].refId).toBe(backendEntityId(connectionId, 'child'));
    expect(JSON.parse(mapped.metadata).threadMessage.fromNodeId).toBe(backendEntityId(connectionId, 'parent'));
    expect(mapBackendPayload(mapped, connectionId, 'server')).toEqual(raw);
  });
});
