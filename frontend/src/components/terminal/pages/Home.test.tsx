import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HomeCard, HomeCardsDto } from 'michi-shared';
import TerminalHome from './Home';
import { PrefsProvider } from '../../../state/prefs';
import { __resetHomeCardsCacheForTests } from '../../../state/homeCards/useHomeCards';
import { AppearancePane } from './settings/AppearancePane';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { useZhCnDefaultLocale } from '../../../test/zhCnLocale';

// What Home asks of its composer. The insertion itself is covered by
// ManageComposer.insert.test.tsx and Home.composerInsert.test.tsx.
const composer = vi.hoisted(() => ({ insert: vi.fn(), startMention: vi.fn() }));
vi.mock('../manage/ManageComposer', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  const FakeComposer = forwardRef(function FakeComposer(props: { toolbarLeftPrefix?: React.ReactNode }, ref) {
    useImperativeHandle(ref, () => composer);
    return <div data-testid="composer">{props.toolbarLeftPrefix}</div>;
  });
  return { default: FakeComposer };
});
vi.mock('../home/ChatHomeDocument', () => ({ default: ({ page }: { page: { title: string } }) => <section aria-label="Home content">{page.title}</section> }));
const chip = vi.hoisted(() => ({ props: vi.fn((_props: unknown) => null) }));
vi.mock('../HomeWorkspaceChip', () => ({ HomeWorkspaceChip: (props: unknown) => chip.props(props) }));

const api = vi.hoisted(() => ({ fetchHomeCards: vi.fn(), markHomeCardUsed: vi.fn() }));
vi.mock('../../../services/api/homeCards', async () => ({
  ...(await vi.importActual<object>('../../../services/api/homeCards')),
  fetchHomeCards: api.fetchHomeCards,
  markHomeCardUsed: api.markHomeCardUsed,
}));

function node(nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, chatId: null, projectId: 'p1', kind: 'chat', title: nodeId, messages: [], followUps: [], status: 'idle', ...extra } as ChatNodeState;
}

const store = vi.hoisted(() => ({
  projects: [] as Project[],
  nodes: {} as Record<string, ChatNodeState>,
  hydrated: true,
  selectProject: vi.fn(),
  enterChatsWorkspace: vi.fn(async () => 'chats-default'),
}));
vi.mock('../../../state/chatStore', async () => ({
  ...(await vi.importActual<object>('../../../state/chatStore')),
  useChatStore: () => ({
    projects: store.projects,
    activeProject: store.projects[0] ?? null,
    activeProjectId: store.projects[0]?.id ?? null,
    hydrated: store.hydrated,
    selectProject: store.selectProject,
    enterChatsWorkspace: store.enterChatsWorkspace,
  }),
  useStructuralSelector: (selector: (n: Record<string, ChatNodeState>) => unknown) => selector(store.nodes),
}));

const withThreads: Project[] = [
  { id: 'p1', name: 'rabbitholes', createdAt: 0, activeTreeId: 't1', chatIds: ['a'], edges: [],
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 10 }] },
  { id: 'p2', name: 'agent-desk', createdAt: 0, activeTreeId: null, chatIds: [], edges: [], trees: [] },
] as unknown as Project[];
const withoutThreads: Project[] = [
  { id: 'p1', name: 'rabbitholes', createdAt: 0, activeTreeId: null, chatIds: [], edges: [], trees: [] },
] as unknown as Project[];

function card(id: string, extra: Partial<HomeCard> = {}): HomeCard {
  return {
    id, kind: 'continue', label: '接着做 · rabbitholes', source: { workspaceId: 'p1' }, title: `Title ${id}`,
    reason: `Reason ${id}`, buttonText: '接着做', prompt: `Prompt ${id}`, workspaceId: 'p1', ...extra,
  };
}
const six = (prefix: string) => Array.from({ length: 6 }, (_, i) => card(`${prefix}${i}`));
function answer(extra: Partial<HomeCardsDto> = {}): HomeCardsDto {
  return {
    greeting: { text: '早上好。昨晚 3 条线有进展。', detail: 'Michi 0.9 还有 5 天发布。' },
    sets: [{ cards: six('a') }, { cards: six('b') }],
    generatedAt: 1, inputFingerprint: 'fp', ...extra,
  };
}

const inserted = () => composer.insert.mock.calls.map(([text]) => text);
const cardTitles = () => screen.queryAllByTestId('home-card').map((el) => el.querySelector('.home-card__title')!.textContent);

const submitted = vi.fn();
async function renderHome() {
  const view = render(<TerminalHome onSubmitted={submitted} />);
  await waitFor(() => expect(api.fetchHomeCards).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

describe('TerminalHome', () => {
  beforeEach(() => {
    store.projects = withThreads;
    store.nodes = { a: node('a') };
    store.hydrated = true;
    store.selectProject.mockReset();
    store.enterChatsWorkspace.mockClear();
    chip.props.mockClear();
    submitted.mockReset();
    composer.insert.mockReset();
    composer.startMention.mockReset();
    api.fetchHomeCards.mockReset().mockResolvedValue(answer());
    api.markHomeCardUsed.mockReset().mockResolvedValue(undefined);
    __resetHomeCardsCacheForTests();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('switches Home between default and Pages content from Settings and restores the saved choice', async () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ homeRecommendations: true }));
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never }));
    const view = render(<PrefsProvider><AppearancePane /><TerminalHome onSubmitted={submitted} /></PrefsProvider>);
    await screen.findByRole('region', { name: 'Home content' });
    const toggle = screen.getByRole('switch', { name: 'Pages recommendations on Home' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Home content' })).toBeNull();
    expect(screen.getByRole('group', { name: 'Quick starts' })).toBeTruthy();
    expect(screen.getByTestId('composer')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Another road diverged');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('michi:v1:prefs')!).homeRecommendations).toBe(false));
    view.unmount();
    render(<PrefsProvider><AppearancePane /><TerminalHome onSubmitted={submitted} /></PrefsProvider>);
    expect(screen.getByRole('switch', { name: 'Pages recommendations on Home' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Home content' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Pages recommendations on Home' }));
    await screen.findByRole('region', { name: 'Home content' });
    localStorage.removeItem('michi:v1:prefs');
  });

  it('keeps the default hero and composer while Pages is loading, then switches to its content', async () => {
    let resolve!: (value: HomeCardsDto) => void;
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>((done) => { resolve = done; }));
    await renderHome();
    const input = screen.getByTestId('composer');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Another road diverged');
    expect(document.querySelector('.home-page')?.getAttribute('data-default-layout')).toBe('true');
    expect(screen.getByRole('group', { name: 'Quick starts' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => resolve(answer({ greeting: null, contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never })));
    await screen.findByRole('region', { name: 'Home content' });
    expect(document.querySelector('.home-page')?.hasAttribute('data-default-layout')).toBe(false);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Quick starts' })).toBeNull();
    expect(screen.getByTestId('composer')).toBe(input);
  });

  it('coming back to Home shows its last content at once, then the fresh read', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null, contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never }));
    const first = await renderHome();
    await screen.findByRole('region', { name: 'Home content' });
    first.unmount();

    let resolve!: (value: HomeCardsDto) => void;
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>((done) => { resolve = done; }));
    const second = render(<TerminalHome onSubmitted={submitted} />);
    expect(screen.getByRole('region', { name: 'Home content' }).textContent).toBe('My home layout');
    expect(document.querySelector('.home-page')?.hasAttribute('data-default-layout')).toBe(false);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    await act(async () => resolve(answer({ greeting: null, contentMode: 'page', contentPage: { id: 'home', title: 'Renamed layout' } as never })));
    expect(screen.getByRole('region', { name: 'Home content' }).textContent).toBe('Renamed layout');
    second.unmount();

    // A failed read is not remembered: the next visit waits with the default hero.
    api.fetchHomeCards.mockRejectedValue(new Error('offline'));
    (await renderHome()).unmount();
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>(() => {}));
    render(<TerminalHome onSubmitted={submitted} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Another road diverged');
    expect(screen.queryByRole('region', { name: 'Home content' })).toBeNull();
  });

  it('coming back to Home leaves out the card clicked last time', async () => {
    const first = await renderHome();
    fireEvent.click(screen.getAllByTestId('home-card')[0]!);
    expect(cardTitles()[0]).toBe('Title a0');
    first.unmount();
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>(() => {}));
    render(<TerminalHome onSubmitted={submitted} />);
    expect(cardTitles()).toEqual(['Title a1', 'Title a2', 'Title a3', 'Title a4', 'Title a5']);
  });

  it('keeps the default layout when Pages has no content or cannot be read', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null, sets: [] }));
    const view = await renderHome();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Another road diverged');
    view.unmount();
    api.fetchHomeCards.mockRejectedValue(new Error('offline'));
    await renderHome();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Another road diverged');
    expect(screen.getByRole('group', { name: 'Quick starts' })).toBeTruthy();
  });

  it('shows the date, the greeting with its second line, the composer, quick starts and six cards', async () => {
    useZhCnDefaultLocale();
    await renderHome();
    // English on a Chinese browser too.
    expect(document.querySelector('.michi-home-eyebrow')!.textContent).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('_ 早上好。昨晚 3 条线有进展。Michi 0.9 还有 5 天发布。');
    expect(screen.getByTestId('composer')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Quick starts' })).getAllByRole('button')).toHaveLength(4);
    expect(cardTitles()).toEqual(['Title a0', 'Title a1', 'Title a2', 'Title a3', 'Title a4', 'Title a5']);
    // Recent threads and the stalled list are gone from Home.
    expect(screen.queryByTestId('home-continue-row')).toBeNull();
    expect(screen.queryByTestId('michi-home-row')).toBeNull();
  });

  it('leaves the greeting out when the Meta agent wrote none', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null }));
    await renderHome();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.querySelector('.michi-home-eyebrow')).toBeTruthy();
  });

  it('a card puts its prompt into the composer without sending, and is marked used', async () => {
    await renderHome();
    fireEvent.click(screen.getAllByTestId('home-card')[0]!);
    expect(inserted()).toEqual(['Prompt a0']);
    expect(submitted).not.toHaveBeenCalled();
    expect(api.markHomeCardUsed).toHaveBeenCalledWith('a0', expect.any(String));
    // It stays on screen until the next read.
    expect(cardTitles()[0]).toBe('Title a0');
  });

  it.each([
    ['Recap today', "Review today's conversations", 'completed work, key decisions, unresolved blockers'],
    ['Draft release notes', 'Draft release notes for this workspace', 'breaking changes or migration steps'],
    ['Find threads stalled 3+ days', 'Find unfinished threads in this workspace', 'at least 3 days'],
    ['Plan tomorrow', 'propose a practical plan for tomorrow', 'up to three main priorities'],
  ])('%s inserts a complete task without sending or switching workspaces', async (label, task, detail) => {
    await renderHome();
    fireEvent.click(screen.getAllByTestId('home-card')[1]!);
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(inserted()).toEqual(['Prompt a1', expect.stringContaining(task)]);
    expect(inserted()[1]).toContain(detail);
    expect(inserted()[1]).toContain('this workspace');
    expect(inserted()[1]).not.toBe(label);
    expect(store.selectProject).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('a card moves the composer to its workspace when that is one of the user\'s', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ sets: [{ cards: [card('x', { workspaceId: 'p2' }), card('y', { workspaceId: 'gone' }), card('z', { workspaceId: null, kind: 'tip', prompt: '' })] }] }));
    await renderHome();
    const [toP2, toGone, tip] = screen.getAllByTestId('home-card');
    fireEvent.click(toP2!);
    expect(store.selectProject).toHaveBeenCalledWith('p2');
    fireEvent.click(toGone!);
    fireEvent.click(tip!);
    expect(store.selectProject).toHaveBeenCalledTimes(1);
    expect(inserted()).toEqual(['Prompt x', 'Prompt y', '']);
  });

  it('Shuffle shows the next set without asking the backend, and comes back round', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ sets: [{ cards: six('a') }, { cards: six('b') }, { cards: [card('c0')] }] }));
    await renderHome();
    const shuffle = screen.getByRole('button', { name: 'Shuffle' });
    fireEvent.click(shuffle);
    expect(cardTitles()[0]).toBe('Title b0');
    fireEvent.click(shuffle);
    expect(cardTitles()).toEqual(['Title c0']);
    fireEvent.click(shuffle);
    expect(cardTitles()[0]).toBe('Title a0');
    expect(api.fetchHomeCards).toHaveBeenCalledTimes(1);
  });

  it('has no Shuffle with a single set, and no cards at all when the Meta agent wrote none', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ sets: [{ cards: six('a') }] }));
    const view = await renderHome();
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull();
    view.unmount();

    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null, sets: [] }));
    await renderHome();
    expect(screen.queryByRole('region', { name: 'Start here' })).toBeNull();
    expect(screen.queryAllByTestId('home-card')).toHaveLength(0);
  });

  it('shows no cards when the cards cannot be read', async () => {
    api.fetchHomeCards.mockRejectedValue(new Error('offline'));
    await renderHome();
    expect(screen.queryAllByTestId('home-card')).toHaveLength(0);
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('sends Full summary on Spaces Home to the Spaces Home', async () => {
    await renderHome();
    const onNav = vi.fn();
    window.addEventListener('michi:nav-page', onNav);
    fireEvent.click(screen.getByRole('button', { name: /Full summary on Pages Home/ }));
    window.removeEventListener('michi:nav-page', onNav);
    expect((onNav.mock.calls[0]![0] as CustomEvent).detail).toEqual({ page: 'spaces' });
  });

  it('honors hidden recommendations instead of substituting onboarding cards', async () => {
    store.projects = withoutThreads;
    store.nodes = {};
    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null, sets: [], cardsCustomized: true }));
    await renderHome();
    expect(screen.queryAllByTestId('home-card')).toHaveLength(0);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('a custom Page replaces both starters and cards while keeping the composer', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never }));
    await renderHome();
    expect(await screen.findByRole('region', { name: 'Home content' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Quick starts' })).toBeNull();
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('missing or hidden custom content never falls back to recommendations', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'page', contentPage: null }));
    const view = await renderHome();
    expect(screen.getByRole('status').textContent).toContain('unavailable');
    expect(cardTitles()).toEqual([]);
    view.unmount();
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'hidden' }));
    await renderHome();
    expect(screen.queryByRole('group', { name: 'Quick starts' })).toBeNull();
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('gives a new user getting-started cards instead, whatever the backend holds', async () => {
    store.projects = withoutThreads;
    store.nodes = {};
    await renderHome();
    expect(cardTitles()).toEqual(['Start a conversation', 'Try branching', '@ a page', 'Open Pages']);
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull();

    const [conversation, , mention, spaces] = screen.getAllByTestId('home-card');
    fireEvent.click(conversation!);
    expect(inserted()).toEqual(['Help me plan what to work on today.']);
    fireEvent.click(mention!);
    expect(composer.startMention).toHaveBeenCalledOnce();
    const onNav = vi.fn();
    window.addEventListener('michi:nav-page', onNav);
    fireEvent.click(spaces!);
    window.removeEventListener('michi:nav-page', onNav);
    expect((onNav.mock.calls[0]![0] as CustomEvent).detail).toEqual({ page: 'spaces' });
    expect(api.markHomeCardUsed).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('waits for the workspaces before deciding the user is new', async () => {
    store.projects = [];
    store.nodes = {};
    store.hydrated = false;
    api.fetchHomeCards.mockResolvedValue(answer({ sets: [] }));
    await renderHome();
    expect(screen.queryAllByTestId('home-card')).toHaveLength(0);
  });

  type ChipProps = { active: { id: string } | null; liveProjects: Array<{ id: string }>; onClear?: () => void };
  const lastChip = () => chip.props.mock.calls.at(-1)![0] as ChipProps;

  it('the workspace chip clears into the folder-less Chats workspace', async () => {
    await renderHome();
    expect(lastChip().active?.id).toBe('p1');
    lastChip().onClear!();
    expect(store.enterChatsWorkspace).toHaveBeenCalledTimes(1);
    expect(store.selectProject).not.toHaveBeenCalled();
  });

  it('shows the Chats workspace as no workspace, not as one to pick', async () => {
    const chats = { id: 'chats-default', name: 'Chats', createdAt: 0, activeTreeId: null, chatIds: [], edges: [], trees: [] };
    store.projects = [chats, ...withThreads] as unknown as Project[];
    await renderHome();
    expect(lastChip().active).toBeNull();
    expect(lastChip().liveProjects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
