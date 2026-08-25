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
