import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flashSpacesBlock, getSpacesHomeIds, loadSpacesHomeIds, openSpacesPage, PAGE_DELETED_MESSAGE, resetSpacesPagesForTests } from './spacesPages';
import { OPEN_NATIVE_PAGE_EVENT } from '../../components/terminal/spaces/SpacesPage';
import { PageApiError } from '../../services/api/pages';
import { OPEN_WORKSPACE_HOME_EVENT } from '../pages/workspaceHomeNav';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const fetchPage = vi.hoisted(() => vi.fn());
vi.mock('../../services/api/pages', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/pages')>('../../services/api/pages');
  return { ...actual, fetchPage };
});

const events: Array<{ type: string; detail: unknown }> = [];
const record = (event: Event) => events.push({ type: event.type, detail: (event as CustomEvent).detail });

beforeEach(() => {
  events.length = 0;
  toast.mockClear();
  fetchPage.mockReset();
  window.addEventListener(OPEN_NATIVE_PAGE_EVENT, record);
  window.addEventListener('michi:nav-page', record);
  window.addEventListener(OPEN_WORKSPACE_HOME_EVENT, record);
});
afterEach(() => {
  window.removeEventListener(OPEN_NATIVE_PAGE_EVENT, record);
  window.removeEventListener('michi:nav-page', record);
  window.removeEventListener(OPEN_WORKSPACE_HOME_EVENT, record);
  resetSpacesPagesForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('openSpacesPage', () => {
  it("opens a page in its own workspace, the Home in place of its page, and only scrolls for the page on screen", async () => {
    fetchPage.mockResolvedValue({ id: 'pg-r', workspaceId: 'ws-r' });
    resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: {} });
    expect(await openSpacesPage({ pageId: 'pg-r' })).toBe('opened');
    expect(await openSpacesPage({ pageId: 'pg-home' })).toBe('opened');
    expect(await openSpacesPage({ pageId: 'pg-r', currentPageId: 'pg-r' })).toBe('opened');
    expect(events).toEqual([
      { type: OPEN_NATIVE_PAGE_EVENT, detail: { pageId: 'pg-r', workspaceId: 'ws-r', backendConnectionId: 'local' } },
      { type: 'michi:nav-page', detail: { page: 'spaces' } },
    ]);
  });

  it('opens a workspace’s default home as that workspace’s home view, not as a plain page', async () => {
    fetchPage.mockResolvedValue({ id: 'pg-ws-home', workspaceId: 'ws-r' });
    resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: { 'ws-r': 'pg-ws-home' } });
    expect(await openSpacesPage({ pageId: 'pg-ws-home' })).toBe('opened');
    expect(events).toEqual([{ type: OPEN_WORKSPACE_HOME_EVENT, detail: { workspaceId: 'ws-r', backendConnectionId: 'local' } }]);
  });

  it('says a deleted page is gone instead of opening it', async () => {
    fetchPage.mockRejectedValue(new PageApiError(404, 'not_found', 'Page not found'));
    expect(await openSpacesPage({ pageId: 'pg-gone', workspaceId: 'ws-r' })).toBe('deleted');
    expect(toast).toHaveBeenCalledWith(PAGE_DELETED_MESSAGE);
    expect(events).toEqual([]);
  });
});

describe('flashSpacesBlock', () => {
  it('waits for the block to render, scrolls to it and flashes it, never inside the window', () => {
    vi.useFakeTimers();
    flashSpacesBlock('b-1');
    document.body.innerHTML = '<section class="meta-chat-panel"><div class="michi-doc-block" id="in-window" data-block-id="b-1"></div></section>'
      + '<div class="michi-doc-block" id="on-page" data-block-id="b-1"></div>';
    const page = document.getElementById('on-page')!;
    page.scrollIntoView = vi.fn();
    vi.advanceTimersByTime(100);
    expect(page.hasAttribute('data-flash')).toBe(true);
    expect(page.scrollIntoView).toHaveBeenCalled();
    expect(document.getElementById('in-window')!.hasAttribute('data-flash')).toBe(false);
    vi.advanceTimersByTime(1300);
    expect(page.hasAttribute('data-flash')).toBe(false);
  });
});

describe('loadSpacesHomeIds', () => {
  it('reads the Spaces Home and each workspace home', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('/workspaces')
      ? { items: [{ workspaceId: 'ws-r', homePageId: 'pg-r-home' }, { workspaceId: 'ws-d', homePageId: null }] }
      : { role: 'spaces-home', page: { id: 'pg-home', title: 'Home' } })))));
    await loadSpacesHomeIds(true);
    expect(getSpacesHomeIds()).toEqual({ home: { id: 'pg-home', title: 'Home' }, workspaces: { 'ws-r': 'pg-r-home' } });
  });
});
