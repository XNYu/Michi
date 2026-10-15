import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

const PROJECT_ID = 'branches-ws';
const BASE_T = 1_781_000_000_000;
const LONG_BRANCH_TITLE = 'Multi-device session family revocation across OAuth providers';

function node(nodeId: string, title: string, branchOverview: string) {
  return {
    nodeId,
    kind: 'chat',
    chatId: `mock-${nodeId}`,
    runtimeId: 'mock',
    projectId: PROJECT_ID,
    messages: [],
    followUps: [],
    title,
    branchOverview,
    status: 'idle',
  };
}

function savedState() {
  return {
    version: 6,
    activeProjectId: PROJECT_ID,
    projects: [{
      id: PROJECT_ID,
      name: 'Auth workspace',
      chatIds: ['root', 'tokens', 'devices', 'oauth', 'other-root'],
      edges: [
        { source: 'root', target: 'tokens', kind: 'branch' },
        { source: 'tokens', target: 'devices', kind: 'branch' },
        { source: 'root', target: 'oauth', kind: 'branch' },
      ],
      trees: [
        { id: 'tree-auth', rootNodeId: 'root', name: 'Authentication redesign', createdAt: BASE_T, lastActiveAt: BASE_T + 2 },
        { id: 'tree-other', rootNodeId: 'other-root', name: 'Other thread', createdAt: BASE_T + 1, lastActiveAt: BASE_T + 1 },
      ],
      activeTreeId: 'tree-auth',
      contexts: [],
      createdAt: BASE_T,
    }],
    nodes: {
      root: node('root', 'Authentication redesign', 'The thread is converging on rotating refresh tokens.'),
      tokens: node('tokens', 'Token refresh model', 'Rotating tokens look safest, pending compatibility checks.'),
      devices: node('devices', LONG_BRANCH_TITLE, 'Device-level sessions need a server-side session family.'),
      oauth: node('oauth', 'OAuth provider compatibility', 'Provider behavior still needs verification.'),
      'other-root': node('other-root', 'Other thread', 'This must not appear in the active thread document.'),
    },
  };
}

async function seed(page: Page) {
  await page.addInitScript((state) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('michi:migrated', '1');
    window.localStorage.setItem('michi:v1:state', JSON.stringify(state));
    window.sessionStorage.setItem('michi:panes:open', JSON.stringify({
      'branches-ws::tree-auth': ['root', 'tokens', 'devices', 'oauth'],
    }));
    window.sessionStorage.setItem('michi:panes:focus', JSON.stringify({
      'branches-ws::tree-auth': 'root',
    }));
  }, savedState());
  await installMockApi(page);
}

test('Branches renders only the active thread as a heading-based document', async ({ page }) => {
  await seed(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Overview' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Authentication redesign' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Token refresh model' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: LONG_BRANCH_TITLE })).toBeVisible();
  await expect(page.getByText('Rotating tokens look safest, pending compatibility checks.')).toBeVisible();
  await expect(page.getByText('This must not appear in the active thread document.')).toHaveCount(0);
});

test('Branches directory mirrors the active thread hierarchy and navigates the document', async ({ page }) => {
  await seed(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Overview' }).click();

  const directory = page.getByRole('navigation', { name: 'Branch directory' });
  await expect(directory.getByRole('treeitem', { name: 'Authentication redesign' })).toHaveAttribute('aria-level', '1');
  await expect(directory.getByRole('treeitem', { name: 'Token refresh model' })).toHaveAttribute('aria-level', '2');
  const longTitle = directory.getByRole('treeitem', { name: LONG_BRANCH_TITLE });
  await expect(longTitle).toHaveAttribute('aria-level', '3');
  await expect(longTitle).toBeVisible();
  expect(await longTitle.evaluate((item) => {
    const style = getComputedStyle(item);
    return style.whiteSpace === 'normal' && item.scrollWidth <= item.clientWidth;
  })).toBe(true);
  await expect(directory.getByRole('treeitem', { name: 'OAuth provider compatibility' })).toHaveAttribute('aria-level', '2');
  await expect(directory.getByRole('treeitem', { name: 'Other thread' })).toHaveCount(0);

  await longTitle.click();
  await expect(longTitle).toHaveAttribute('aria-current', 'location');
});

test('opening a Branches node centers its focused Dashboard pane', async ({ page }) => {
  await seed(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Overview' }).click();
  await page.getByRole('button', { name: `Open ${LONG_BRANCH_TITLE}` }).click();

  const landing = await page.locator('.terminal-dashboard').evaluate((strip) => {
    const pane = strip.querySelector('[data-node-id="devices"]')!;
    const stripBox = strip.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    return {
      stripCenter: stripBox.left + stripBox.width / 2,
      paneCenter: paneBox.left + paneBox.width / 2,
    };
  });
  expect(Math.abs(landing.paneCenter - landing.stripCenter)).toBeLessThanOrEqual(2);
});

const LONG_PROJECT_ID = 'long-read-ws';
const LONG_SECTION_COUNT = 30;
const longSectionId = (index: number) => `s${String(index).padStart(2, '0')}`;
const longSectionTitle = (index: number) =>
  `Section ${String(index).padStart(2, '0')} · deployment finding with a title long enough to wrap`;

function longReadState() {
  const paragraph = 'The reader needs enough body copy here for every section to span a good part of the viewport. ';
  const sectionIds = Array.from({ length: LONG_SECTION_COUNT }, (_, index) => longSectionId(index + 1));
  const nodes = Object.fromEntries(sectionIds.map((id, index) => [id, {
    ...node(id, longSectionTitle(index + 1), `${paragraph.repeat(5)}\n\n${paragraph.repeat(4)}`),
    projectId: LONG_PROJECT_ID,
  }]));
  return {
    version: 6,
    activeProjectId: LONG_PROJECT_ID,
    projects: [{
      id: LONG_PROJECT_ID,
      name: 'Long read workspace',
      chatIds: ['long-root', ...sectionIds],
      edges: sectionIds.map((id) => ({ source: 'long-root', target: id, kind: 'branch' })),
      trees: [{ id: 'tree-long', rootNodeId: 'long-root', name: 'Long read', createdAt: BASE_T, lastActiveAt: BASE_T }],
      activeTreeId: 'tree-long',
      contexts: [],
      createdAt: BASE_T,
    }],
    nodes: {
      'long-root': { ...node('long-root', 'Long read', 'A thread with many branches.'), projectId: LONG_PROJECT_ID },
      ...nodes,
    },
  };
}

async function openLongRead(page: Page) {
  // Instant scrolling keeps the outline's auto-follow deterministic.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript((state) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('michi:migrated', '1');
    window.localStorage.setItem('michi:v1:state', JSON.stringify(state));
  }, longReadState());
  await installMockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Overview' }).click();
}

/** Whether the outline item is fully visible inside both the outline card and the page scroller. */
function outlineItemVisible(item: ReturnType<Page['getByRole']>) {
  return item.evaluate((element) => {
    const nav = element.closest('nav')!.getBoundingClientRect();
    const main = element.closest('main')!.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return rect.top >= Math.max(nav.top, main.top) && rect.bottom <= Math.min(nav.bottom, main.bottom);
  });
}

test('Branches outline follows the section being read and keeps it in view', async ({ page }) => {
  await openLongRead(page);

  const directory = page.getByRole('navigation', { name: 'Branch directory' });
  const documentScroller = page.getByRole('main', { name: 'Branch overview' });
  const item = (index: number) => directory.getByRole('treeitem', { name: longSectionTitle(index) });

  await expect(directory.getByRole('treeitem', { name: 'Long read' })).toHaveAttribute('aria-current', 'location');
  await expect.poll(() => directory.evaluate(element =>
    element.getBoundingClientRect().bottom <= element.closest('main')!.getBoundingClientRect().bottom,
  )).toBe(true);
  expect(await outlineItemVisible(item(24))).toBe(false);

  // Bring section 24's heading just below the top edge, as a reader would.
  await documentScroller.evaluate((scroller, id) => {
    const heading = document.getElementById(`branch-${id}`)!;
    scroller.scrollTop += heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40;
  }, longSectionId(24));

  await expect(item(24)).toHaveAttribute('aria-current', 'location');
  await expect.poll(() => outlineItemVisible(item(24))).toBe(true);

  // A shorter shell viewport must also keep the current outline item visible.
  await page.setViewportSize({ width: 1280, height: 560 });
  await expect(item(24)).toHaveAttribute('aria-current', 'location');
  await expect.poll(() => outlineItemVisible(item(24))).toBe(true);

  // Short trailing sections cannot reach the reading line; the end belongs to the last one.
  await documentScroller.evaluate((scroller) => { scroller.scrollTop = scroller.scrollHeight; });
  await expect(item(LONG_SECTION_COUNT)).toHaveAttribute('aria-current', 'location');
  await expect.poll(() => outlineItemVisible(item(LONG_SECTION_COUNT))).toBe(true);
});

test('Branches outline click holds its section until the reader scrolls again', async ({ page }) => {
  await openLongRead(page);

  const directory = page.getByRole('navigation', { name: 'Branch directory' });
  const item = (index: number) => directory.getByRole('treeitem', { name: longSectionTitle(index) });

  await item(3).click();
  await expect(item(3)).toHaveAttribute('aria-current', 'location');

  const article = await page.locator('.branches-document').boundingBox();
  const scroller = page.getByRole('main', { name: 'Branch overview' });
  const viewport = await scroller.boundingBox();
  const previousScrollTop = await scroller.evaluate(element => element.scrollTop);
  // The article's top has scrolled off-screen; target its visible portion.
  await page.mouse.move(article!.x + article!.width / 2, viewport!.y + viewport!.height / 2);
  await page.mouse.wheel(0, 1600);
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(previousScrollTop);

  await expect(item(3)).not.toHaveAttribute('aria-current', 'location');
  await expect(directory.locator('[aria-current="location"]')).toHaveCount(1);
  const current = await directory.locator('[aria-current="location"]').innerText();
  expect(Number(/Section (\d+)/.exec(current)?.[1])).toBeGreaterThan(3);
});
