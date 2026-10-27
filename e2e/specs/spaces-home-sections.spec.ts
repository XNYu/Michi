import { expect, test, type Page } from '@playwright/test';
import type { HomeConversationItem, HomeSectionKey } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { areaButton, openArea } from '../fixtures/shell';
import { createSpacesHomeMock } from '../fixtures/spacesHomeFixtures';

// Waiting on you, Stalled and Just done on the Spaces Home come from Michi's
// own conversations; Agent Desk is not running here and is never needed.

const WS = 'ws-rabbitholes';
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

interface Chat { id: string; title: string; reply: string; state: HomeSectionKey | null; summary: string; ago: number }
const CHATS: Chat[] = [
  { id: 'n-crew', title: 'Michi 打包为 Crew App', reply: '安装路径用 ~/.kiro/crew/apps，还是独立目录？', state: 'waiting',
    summary: 'Asked: 安装路径用 ~/.kiro/crew/apps，还是独立目录？', ago: 2 * 60 * MIN },
  { id: 'n-incr', title: 'Pages 增量读取边界', reply: '重复提交的用例通过了。', state: 'waiting', summary: 'Failed: SQLITE_BUSY: database is locked', ago: 3 * 60 * MIN },
  { id: 'n-acp', title: '常驻 ACP 阅读池设计', reply: 'Running the suite next.', state: 'stalled', summary: 'Waiting for your approval: Run npm test', ago: 4 * DAY },
  { id: 'n-page', title: '录屏时间线分页', reply: 'Should I page by cursor?', state: 'stalled', summary: 'Asked: Should I page by cursor?', ago: 6 * DAY },
  { id: 'n-notarize', title: '排查公证失败', reply: '补上 allow-jit entitlement 并重新签名，公证通过。', state: 'done',
    summary: '补上 allow-jit entitlement 并重新签名，公证通过。', ago: 50 * MIN },
  { id: 'n-calm', title: '发布说明草稿', reply: 'Draft is in the doc.', state: null, summary: '', ago: 2 * DAY },
];

function seed(now: number, reminders = false) {
  const workspace = {
    workspace: { id: WS, name: 'rabbitholes', active_tree_id: `${CHATS[0]!.id}-tree`, created_at: 1 },
    trees: CHATS.map((chat) => ({ id: `${chat.id}-tree`, workspace_id: WS, root_node_id: chat.id, name: chat.title, created_at: 1, last_active_at: now - chat.ago })),
    nodes: CHATS.map((chat) => ({ id: chat.id, workspace_id: WS, tree_id: `${chat.id}-tree`, kind: 'chat', title: chat.title, runtime_id: 'mock', status: 'idle', created_at: 1 })),
    edges: [], contexts: [], artifacts: [],
    messages: CHATS.flatMap((chat) => [
      { id: `${chat.id}-u`, node_id: chat.id, role: 'user', seq: 0, content: `About ${chat.title}` },
      { id: `${chat.id}-a`, node_id: chat.id, role: 'assistant', seq: 1, content: chat.reply },
    ]),
  };
  const item = (chat: Chat): HomeConversationItem => ({
    id: `conversation:${chat.id}`, kind: 'conversation', workspaceId: WS, workspaceName: 'rabbitholes', title: chat.title, at: now - chat.ago,
    ...(reminders ? { reminderVersion: 'v1' } : {}),
    summary: chat.summary, agentClaim: false, state: chat.state, target: { kind: 'conversation', nodeId: chat.id, workspaceId: WS, messageId: `${chat.id}-a` },
  });
  const conversations = CHATS.map(item);
  const section = (state: HomeSectionKey, shown = Infinity) => {
    const items = conversations.filter((entry) => entry.state === state);
    return { items: items.slice(0, shown), total: items.length };
  };
  const spaces = createSpacesHomeMock({
    // Stalled lists one of its two, as a layout rule would: the rest is behind View all.
    sections: { waiting: section('waiting'), stalled: section('stalled', 1), done: section('done'),
      byWorkspace: { [WS]: { waiting: 2, stalled: 2 } }, conversationTotal: CHATS.length },
    conversations,
    homeBlocks: [{ id: 'lead', rev: 1, type: 'markdown', text: 'Today across your workspaces.' }, { id: 'waiting', rev: 1, type: 'home-section', section: 'waiting' }],
    workspaceHomes: { [WS]: { name: 'rabbitholes', blocks: [{ id: 'summary', rev: 1, type: 'markdown', text: 'Release work is in progress.' }] } },
  });
  return { workspace, spaces };
}

async function bootSpacesHome(page: Page, reminders = false) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { workspace, spaces } = seed(Date.now(), reminders);
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1 }));
    localStorage.setItem('michi:migrated', '1');
  });
  await installMockApi(page, { workspaces: [workspace], custom: spaces.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  const home = page.locator('main.spaces-home');
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  return {
    errors, spaces, home,
    sidebar: page.locator('.spaces-side'),
    waiting: home.getByRole('region', { name: 'Waiting on you' }),
    stalled: home.getByRole('region', { name: 'Stalled' }),
    done: home.getByRole('region', { name: 'Just done' }),
  };
}

test('the Spaces Home counts Waiting, Stalled and Just done from Michi conversations, with no Agent Desk', async ({ page }) => {
  const { errors, home, sidebar, waiting, stalled, done } = await bootSpacesHome(page);

  await expect(home.getByText('Across all workspaces · kept up to date by the Meta agent')).toHaveCount(0);
  await expect(home.locator('.spaces-home-status')).toHaveCount(0);
  await home.screenshot({ path: '.artifacts/spaces-home-cleanup/home.png', animations: 'disabled' });
  await expect(home.getByText('Counted from your chats')).toHaveCount(3);
  await expect(home.getByRole('group', { name: "Today's agenda" })).toHaveCount(0);
  await expect(areaButton(page, 'spaces')).toHaveAccessibleName('Pages, 2 waiting');
  await expect(sidebar.getByRole('button', { name: /^Home/ })).toContainText('2');
  await expect(sidebar.getByRole('button', { name: /^All threads/ })).toHaveCount(0);
  await expect(sidebar.locator(`[data-workspace="${WS}"] .area-side__dot`)).toHaveAttribute('data-tone', 'waiting');

  await expect(waiting.getByTestId('spaces-home-row')).toHaveCount(2);
  await expect(waiting.getByText('Asked: 安装路径用 ~/.kiro/crew/apps，还是独立目录？')).toBeVisible();
  await expect(waiting.getByText('Failed: SQLITE_BUSY: database is locked')).toBeVisible();
  await expect(stalled.getByTestId('spaces-home-row')).toHaveCount(1);
  await expect(stalled.getByText('quiet 4d')).toBeVisible();
  await expect(stalled.getByText('Waiting for your approval: Run npm test')).toBeVisible();
  await expect(done.getByTestId('spaces-home-row')).toHaveCount(1);
  await expect(home.getByText('Conversation state could not be read just now.')).toHaveCount(0);

  // Tab moves through each row's workspace link and its action; Enter opens the conversation at its reply.
  const first = waiting.getByRole('button', { name: 'Back to chat: Michi 打包为 Crew App' });
  await first.focus();
  await page.keyboard.press('Tab');
  await expect(waiting.getByTestId('spaces-home-row').nth(1).getByRole('button', { name: 'rabbitholes' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(waiting.getByRole('button', { name: 'Back to chat: Pages 增量读取边界' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Back to Pages' })).toHaveCount(0);
  await expect(page.getByText('安装路径用 ~/.kiro/crew/apps，还是独立目录？').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Just done drops a conversation once you open it, and leaving the Home records the look', async ({ page }) => {
  const { errors, spaces, home, done } = await bootSpacesHome(page);
  await done.getByRole('button', { name: 'View chat: 排查公证失败' }).click();
  await expect(page.getByText('补上 allow-jit entitlement 并重新签名，公证通过。').first()).toBeVisible();
  await expect.poll(() => spaces.requests.filter((request) => request === 'POST /spaces-home/look').length).toBe(1);

  await openArea(page, 'spaces');
  await expect(home.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  await expect(done.getByTestId('spaces-home-row')).toHaveCount(0);
  await expect(done.getByText('Nothing finished since you last looked.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('View all expands conversations in place and keeps All threads removed', async ({ page }) => {
  const { errors, spaces, stalled } = await bootSpacesHome(page);
  await stalled.getByRole('button', { name: /View all/ }).click();
  await expect(stalled.getByTestId('spaces-home-row')).toHaveCount(2);
  await expect(stalled.getByText('Asked: Should I page by cursor?')).toBeVisible();
  await expect(page.getByRole('main', { name: 'All threads' })).toHaveCount(0);
  expect(spaces.requests).toContain('GET /spaces-home/conversations?state=stalled&limit=500');
  await stalled.getByRole('button', { name: /Show less/ }).click();
  await expect(stalled.getByTestId('spaces-home-row')).toHaveCount(1);
  await stalled.getByRole('button', { name: /View all/ }).click();
  await expect(stalled.getByTestId('spaces-home-row')).toHaveCount(2);
  await stalled.getByRole('button', { name: 'Continue: 常驻 ACP 阅读池设计' }).click();
  await expect(page.getByText('Running the suite next.').first()).toBeVisible();
  expect(errors).toEqual([]);
});


test('Waiting can move, dismiss and snooze reminders with undo and matching badges', async ({ page }) => {
  const { home, waiting } = await bootSpacesHome(page, true);
  await expect(waiting.getByRole('button', { name: /Move (up|down)/ })).toHaveCount(0);
  const frame = home.locator('[data-block-id="waiting"]');
  const lead = home.locator('[data-block-id="lead"]');
  await frame.hover();
  const handle = frame.getByRole('button', { name: 'Block menu' });
  const origin = (await handle.boundingBox())!;
  const destination = (await lead.boundingBox())!;
  await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + 20, destination.y + 2, { steps: 12 });
  await expect(page.locator('.native-page-drop')).toBeVisible();
  await page.mouse.up();
  await expect(home.locator('[data-native-page] > .michi-doc-block[data-top]').first()).toHaveAttribute('data-block-id', 'waiting');
  await page.reload();
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  await expect(home.locator('[data-native-page] > .michi-doc-block[data-top]').first()).toHaveAttribute('data-block-id', 'waiting');
  await waiting.getByRole('button', { name: 'No longer needs attention: Pages 增量读取边界' }).click();
  await expect(waiting.getByTestId('spaces-home-row')).toHaveCount(1);
  await expect(areaButton(page, 'spaces')).toHaveAccessibleName('Pages, 1 waiting');
  await waiting.getByRole('button', { name: 'Undo' }).click();
  await expect(waiting.getByTestId('spaces-home-row')).toHaveCount(2);
  await waiting.getByRole('button', { name: 'Remind tomorrow: Pages 增量读取边界' }).click();
  await expect(waiting.getByTestId('spaces-home-row')).toHaveCount(1);
  await expect(waiting.getByRole('status')).toContainText('Reminder moved to tomorrow');
  await frame.hover();
  await frame.getByRole('button', { name: 'Block menu' }).click();
  await page.getByRole('menuitem', { name: /^Archive/ }).click();
  await expect(waiting).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  await expect(waiting).toHaveCount(0);
});
