import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { openThreadFromSidebar } from '../fixtures/shell';

const PANE = (id: string) => `.terminal-dashboard > [data-node-id="${id}"]`;

async function boot(page: Page, reduceMotion = false) {
  await installMockApi(page);
  await page.addInitScript((reduceMotion) => {
    localStorage.clear(); sessionStorage.clear();
    const ids = ['root', 'closed'];
    const titles = ['Root note', 'Closed branch'];
    const nodes = Object.fromEntries(ids.map((id, i) => [id, {
      nodeId: id, title: titles[i], kind: 'chat', chatId: null, projectId: 'phone', status: 'idle', followUps: [], messagesLoaded: true,
      messages: [{ id: id + '-q', role: 'user', text: titles[i], toolCalls: [], createdAt: 1 },
        { id: id + '-a', role: 'assistant', text: 'A quiet workspace keeps each conversation and its reading position.', toolCalls: [], createdAt: 2 }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'phone', nodes, projects: [{
      id: 'phone', name: 'Mobile workspace', createdAt: 1, chatIds: ids, activeTreeId: 'tree',
      trees: [{ id: 'tree', rootNodeId: 'root', name: titles[0], createdAt: 1, lastActiveAt: 2 }],
      edges: [{ source: 'root', target: 'closed' }],
    }] }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarView: 'structure', sidebarCollapsed: true,
      sidebarExpanded: { workspaces: { phone: true }, threads: {}, branches: {} }, reduceMotion }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'phone::tree': ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'phone::tree': 'root' }));
  }, reduceMotion);
  await page.goto('/');
  await openThreadFromSidebar(page, 'Root note');
  await expect(page.locator(PANE('root'))).toBeVisible();
}

/** Freeze every later animation so its frames can be measured, not raced. */
async function freezeAnimations(page: Page) {
  await page.evaluate(() => {
    const frozen: Animation[] = [];
    (window as unknown as { frozen: Animation[] }).frozen = frozen;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (...args: Parameters<typeof original>) {
      const animation = original.apply(this, args);
      animation.pause();
      frozen.push(animation);
      return animation;
    };
  });
}

const seek = (page: Page, selector: string, time: number) => page.evaluate(({ selector, time }) => {
  for (const animation of (window as unknown as { frozen: Animation[] }).frozen) {
    if ((animation.effect as KeyframeEffect).target?.matches(selector)) animation.currentTime = time;
  }
}, { selector, time });

const finishAll = (page: Page) => page.evaluate(() => {
  for (const animation of (window as unknown as { frozen: Animation[] }).frozen) {
    if (animation.playState !== 'finished' && animation.playState !== 'idle') animation.finish();
  }
});

const framedPaneAnimations = (page: Page) => page.evaluate(() => (window as unknown as { frozen: Animation[] }).frozen
  .filter(animation => (animation.effect as KeyframeEffect).target?.matches('.terminal-dashboard > [data-node-id]')).length);

test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 390, height: 844 }); });

test('branching from a message pushes the new pane over its parent', async ({ page }, info) => {
  await boot(page);
  await freezeAnimations(page);
  const branch = page.locator(PANE('root')).getByRole('button', { name: 'branch from here' }).first();
  await page.locator(PANE('root')).getByText('Root note').first().hover();
  await branch.click();

  const incoming = page.locator('.terminal-dashboard > [data-node-id]:not([data-node-id="root"])');
  await expect(incoming).toHaveCount(1);
  await seek(page, '.terminal-dashboard > [data-node-id]', 120);
  // Mid-push both panes are on screen: the parent drifting left, the branch covering it.
  await expect(page.locator(PANE('root'))).toBeVisible();
  const [parent, child] = [(await page.locator(PANE('root')).boundingBox())!, (await incoming.boundingBox())!];
  expect(parent.x).toBeLessThan(0);
  expect(parent.x).toBeGreaterThan(-390 * 0.24 - 1);
  expect(child.x).toBeGreaterThan(0);
  expect(child.x).toBeLessThan(390);
  await page.screenshot({ path: info.outputPath('branch-push-mid.png') });

  await finishAll(page);
  await expect.poll(async () => (await incoming.boundingBox())!.x).toBeLessThan(1);
  await expect(page.locator('.terminal-dashboard > [data-node-id]:visible')).toHaveCount(1);
  await expect(page.locator(PANE('root'))).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('tapping a message reaches branch from here, and the push settles on the new pane', async ({ page }, info) => {
    await boot(page);
    await page.locator(PANE('root')).getByText('A quiet workspace').tap();
    await page.locator(PANE('root')).getByRole('button', { name: 'branch from here' }).last().tap();
    const incoming = page.locator('.terminal-dashboard > [data-node-id]:not([data-node-id="root"])');
    await expect(incoming).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running'
      && (animation.effect as KeyframeEffect).target?.matches('.terminal-dashboard > [data-node-id]')).length)).toBe(0);
    await expect(page.locator(PANE('root'))).toBeHidden();
    expect(Math.abs((await incoming.boundingBox())!.x)).toBeLessThan(1);
    await page.screenshot({ path: info.outputPath('branch-push-settled.png') });
  });
});

test('a background branch flies from the tap to the switcher and leaves the pane in place', async ({ page }, info) => {
  await boot(page);
  await freezeAnimations(page);
  await page.locator(PANE('root')).getByRole('textbox', { name: 'Message' }).click();
  await page.locator(PANE('root')).getByRole('textbox', { name: 'Message' }).fill('A tangent');
  const button = page.locator(PANE('root')).getByRole('button', { name: /^Branch/ });
  const origin = (await button.boundingBox())!;
  await button.click();

  const chip = page.locator('.mobile-branch-flight');
  await expect(chip).toHaveCount(1);
  await seek(page, '.mobile-branch-flight', 72);
  const start = (await chip.boundingBox())!;
  expect(Math.abs(start.x + start.width / 2 - (origin.x + origin.width / 2))).toBeLessThan(origin.width);
  await page.screenshot({ path: info.outputPath('branch-flight-start.png') });
  const target = (await page.getByRole('button', { name: 'Switch pane' }).boundingBox())!;
  await seek(page, '.mobile-branch-flight', 359);
  const end = (await chip.boundingBox())!;
  expect(Math.abs(end.x + end.width / 2 - (target.x + target.width / 2))).toBeLessThan(4);

  await expect(page.locator(PANE('root'))).toBeVisible();
  await expect(page.locator('.terminal-dashboard > [data-node-id]:visible')).toHaveCount(1);
  expect(await framedPaneAnimations(page)).toBe(0);
  await finishAll(page);
  await expect(chip).toHaveCount(0);

  // The landing: the switcher swells in the accent colour and throws a ring.
  const trigger = page.getByRole('button', { name: 'Switch pane' });
  await seek(page, '.mobile-pane-trigger', 126);
  const landing = await trigger.evaluate(el => {
    const button = getComputedStyle(el);
    const ring = getComputedStyle(el, '::after');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--term-accent');
    return { width: el.getBoundingClientRect().width, resting: el.offsetWidth, color: button.color, ringOpacity: Number(ring.opacity), accent };
  });
  expect(landing.width / landing.resting).toBeGreaterThan(1.3);
  expect(landing.ringOpacity).toBeGreaterThan(0);
  await page.screenshot({ path: info.outputPath('branch-landing.png') });
  await page.evaluate(() => { for (const animation of (window as unknown as { frozen: Animation[] }).frozen) animation.cancel(); });
  expect(await trigger.evaluate(el => el.getBoundingClientRect().width / el.offsetWidth)).toBeCloseTo(1);
});

test('reopening a closed branch stays instant', async ({ page }) => {
  await boot(page);
  await freezeAnimations(page);
  await page.getByRole('button', { name: 'Switch pane' }).click();
  await page.getByRole('navigation', { name: 'Branches and panes' }).getByRole('button', { name: 'Closed branch' }).click();
  await expect(page.locator(PANE('closed'))).toBeVisible();
  await expect(page.locator(PANE('root'))).toBeHidden();
  expect(await framedPaneAnimations(page)).toBe(0);
});

test('reduced motion fades the branch in without moving anything', async ({ page }) => {
  await boot(page, true);
  await page.locator(PANE('root')).getByRole('textbox', { name: 'Message' }).click();
  await page.locator(PANE('root')).getByRole('textbox', { name: 'Message' }).fill('A tangent');
  await page.locator(PANE('root')).getByRole('button', { name: /^Branch/ }).click();
  await expect(page.getByRole('button', { name: 'Switch pane' })).toBeVisible();
  await expect(page.locator('.mobile-branch-flight')).toHaveCount(0);
  await expect(page.locator(PANE('root'))).toBeVisible();
});
