import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageSummaryDto, SpaceSummaryDto } from 'michi-shared';
import { streamMessage } from '../../services/api/stream';
import { metaAgentTurnContextFor, provideMetaAgentTurnContext } from '../../services/api/assistant';
import { writeResource } from '../pages/resourceCache';
import { spacesResourceKey } from '../pages/useSpaces';
import { spaceTreeResourceKey } from '../pages/useSpaceTree';
import { buildMetaAgentTurnContext } from './turnContext';
import { resetSpacesPagesForTests } from './spacesPages';

afterEach(() => {
  vi.unstubAllGlobals();
  resetSpacesPagesForTests();
});

const workspaces = [{ id: 'ws-r', name: 'rabbitholes' }];

describe('buildMetaAgentTurnContext', () => {
  it('names the page on screen, the selected block and the pages the sidebar knows', () => {
    resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: { 'ws-r': 'pg-r-home' } });
    writeResource<SpaceSummaryDto[]>(spacesResourceKey('local'), [{ id: 'pg-release', title: 'Michi 0.9 发布', workspaceId: 'ws-r' } as SpaceSummaryDto]);
    writeResource<PageSummaryDto[]>(spaceTreeResourceKey('local', 'ws-r'), [
      { id: 'pg-release', title: 'Michi 0.9 发布', workspaceId: 'ws-r' } as PageSummaryDto,
      { id: 'pg-research', title: '竞品研究', workspaceId: 'ws-r' } as PageSummaryDto,
      { id: 'remote:host:pg-x', title: 'Remote', workspaceId: 'remote:host:ws' } as PageSummaryDto,
    ]);

    expect(buildMetaAgentTurnContext({ view: { kind: 'home' }, target: null, workspaces })).toEqual({
      pageId: 'pg-home',
      blockId: null,
      pages: [
        { id: 'pg-home', title: 'Home' },
        { id: 'pg-r-home', title: 'rabbitholes', workspaceId: 'ws-r' },
        { id: 'pg-release', title: 'Michi 0.9 发布', workspaceId: 'ws-r' },
        { id: 'pg-research', title: '竞品研究', workspaceId: 'ws-r' },
      ],
    });
    const onWorkspace = buildMetaAgentTurnContext({ view: { kind: 'workspace', workspaceId: 'ws-r', name: 'rabbitholes' }, target: { pageId: 'pg-r-home', blockId: 'b-next' }, workspaces });
    expect(onWorkspace).toMatchObject({ pageId: 'pg-r-home', blockId: 'b-next' });
    const remotePage = buildMetaAgentTurnContext({ view: { kind: 'page', backendConnectionId: 'host', workspaceId: 'remote:host:ws', pageId: 'remote:host:pg-x' }, target: null, workspaces });
    expect(remotePage).toMatchObject({ pageId: null, blockId: null });
    expect(remotePage).not.toHaveProperty('remoteWorkspaces');
  });

  it('names the checklist item a target is narrowed to, clipped to the title bound', () => {
    resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: {} });
    const item = buildMetaAgentTurnContext({ view: { kind: 'home' }, target: { pageId: 'pg-home', blockId: 'focus', item: { index: 5, text: 'x'.repeat(400) } }, workspaces });
    expect(item).toMatchObject({ pageId: 'pg-home', blockId: 'focus', blockItem: { index: 5, text: 'x'.repeat(300) } });
    expect(buildMetaAgentTurnContext({ view: { kind: 'home' }, target: { pageId: 'pg-home', blockId: 'focus' }, workspaces })).not.toHaveProperty('blockItem');
    expect(buildMetaAgentTurnContext({ view: { kind: 'home' }, target: { pageId: 'pg-home', blockId: 'focus', item: { index: -1, text: 'bad' } }, workspaces })).not.toHaveProperty('blockItem');
  });

  it('names the remote workspaces, and the one on screen, so the Meta agent can say Spaces doesn’t support them', () => {
    resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: {} });
    const remoteWorkspaces = [{ id: 'remote:host:ws', name: 'Far away' }];
    expect(buildMetaAgentTurnContext({ view: { kind: 'page', backendConnectionId: 'host', workspaceId: 'remote:host:ws', pageId: 'remote:host:pg-x' }, target: null, workspaces, remoteWorkspaces }))
      .toMatchObject({ pageId: null, remoteWorkspaces: ['Far away'], remoteOnScreen: 'Far away' });
    expect(buildMetaAgentTurnContext({ view: { kind: 'home' }, target: null, workspaces, remoteWorkspaces }))
      .toMatchObject({ pageId: 'pg-home', remoteWorkspaces: ['Far away'], remoteOnScreen: null });
  });
});

describe('metaAgentContext on the wire', () => {
  it('rides on each message to the registered assistant node only, read when it is sent', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response('event: done\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    }));
    let pageId = 'pg-home';
    const stop = provideMetaAgentTurnContext('n-assistant', () => ({ pageId, blockId: null, pages: [] }));
    const done = () => new Promise<void>((resolve) => { streamMessage('n-assistant', 'hi', { onDone: () => resolve(), onError: () => resolve() }); });
    await done();
    pageId = 'pg-r-home';
    await done();
    await new Promise<void>((resolve) => { streamMessage('n-other', 'hi', { onDone: () => resolve(), onError: () => resolve() }); });
    stop();
    expect(metaAgentTurnContextFor('n-assistant')).toBeUndefined();
    expect(bodies.map((b) => b.metaAgentContext)).toEqual([
      { pageId: 'pg-home', blockId: null, pages: [] },
      { pageId: 'pg-r-home', blockId: null, pages: [] },
      undefined,
    ]);
  });
});
