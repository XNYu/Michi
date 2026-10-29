import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PageBlock } from 'michi-shared';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';
import { createSpacesLiveUpdatesMock, liveAssistant, liveWorkspace, LIVE_PAGE_ID } from '../fixtures/spacesLiveUpdatesFixtures';

const evidence = resolve('.artifacts/pages-view-interactions');
const action = (viewId: string, presentation: 'inline' | 'drawer' | 'modal') => ({ type: 'open-view' as const, viewId, presentation });
const blocks: PageBlock[] = [
  { id: 'intro', rev: 1, type: 'markdown', text: '## Choose a release approach\n\nThe recommendation is staged rollout. [Read the evidence](#view/evidence).' },
  { id: 'metrics', rev: 1, type: 'metrics', items: [{ label: 'Options', value: '2', action: action('options', 'inline') }, { label: 'Reviewed', value: '5' }] },
  { id: 'summary', rev: 1, type: 'callout', tone: 'info', title: 'Staged rollout', text: 'Start with a smaller group, then expand after review.', interaction: { label: 'Compare options', action: action('options', 'modal') } },
  { id: 'options-view', rev: 1, type: 'view', viewId: 'options', title: 'Release options', blockIds: ['option-table'] },
  { id: 'option-table', rev: 1, type: 'table', columns: ['Approach', 'Benefit', 'Tradeoff'], rows: [['Staged', 'Earlier feedback', 'More review steps'], ['All at once', 'One transition', 'Larger initial impact']], visibility: 'detail' },
  { id: 'evidence-view', rev: 1, type: 'view', viewId: 'evidence', title: 'Recommendation evidence', blockIds: ['research', 'notes', 'long-context', 'source-link'] },
  { id: 'research', rev: 1, type: 'markdown', text: '### Evidence from the pilot\n\nThe small pilot surfaced integration issues before the wider release.', visibility: 'detail' },
  { id: 'notes', rev: 1, type: 'markdown', text: 'Private review note', visibility: 'detail' },
  { id: 'long-context', rev: 1, type: 'markdown', text: Array.from({ length: 14 }, (_, i) => `**Observation ${i + 1}.** The review compares adoption, feedback and operational readiness before expanding the audience.`).join('\n\n'), visibility: 'detail' },
  { id: 'source-link', rev: 1, type: 'view-link', label: 'Original source', action: action('source', 'drawer'), visibility: 'detail' },
  { id: 'source-view', rev: 1, type: 'view', viewId: 'source', title: 'Pilot source', blockIds: ['source-text'] },
  { id: 'source-text', rev: 1, type: 'markdown', text: 'The pilot covered three integration paths. All findings were reviewed.', visibility: 'detail' },
];

test('optional page entries open native content, retain navigation state and do not write', async ({ page }) => {
  mkdirSync(evidence, { recursive: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  const errors: string[] = [], writes: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/pages\/[^/]+\/edits/.test(request.url())) writes.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette: 'bone', uiFont: 'Geist' }));
    localStorage.setItem('michi:migrated', '1');
  });
  const mock = createSpacesLiveUpdatesMock();
  mock.pages.set(LIVE_PAGE_ID, { ...mock.pages.get(LIVE_PAGE_ID)!, blocks });
  await installMockApi(page, { workspaces: [liveWorkspace, liveAssistant], custom: mock.handle });
  await page.goto('/');
  await expect(page.locator('.home-page')).toBeVisible();
  await openArea(page, 'spaces');
  await page.locator('.spaces-side').getByRole('button', { name: 'Release work', exact: true }).click();
  await page.locator('.spaces-home-space-card').filter({ hasText: 'Live release' }).click();
  const assistant = page.getByRole('region', { name: 'Assistant', exact: true });
  if (await assistant.isVisible()) await assistant.getByRole('button', { name: 'Minimize', exact: true }).click();
  const main = page.getByRole('main', { name: 'Live release', exact: true });
  await expect(main.getByText('Earlier feedback', { exact: true })).toHaveCount(0);

  const trigger = main.getByRole('link', { name: 'Read the evidence', exact: true });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'Recommendation evidence', exact: true });
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toHaveAttribute('aria-modal', 'true');
  await expect(drawer.getByRole('heading', { name: 'Evidence from the pilot' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: resolve(evidence, 'drawer.png') });

  const note = drawer.locator('.michi-doc-block[data-block-id="notes"]');
  await note.hover();
  await note.getByRole('button', { name: 'Edit', exact: true }).click();
  const draft = drawer.getByRole('textbox', { name: 'Edit Private review note', exact: true });
  await draft.fill('Keep this unsaved note');
  await draft.evaluate(element => (element as HTMLTextAreaElement).setSelectionRange(2, 8));
  const draftNode = await draft.elementHandle();
  const sourceLink = drawer.getByRole('link', { name: 'Original source', exact: true });
  await sourceLink.scrollIntoViewIfNeeded();
  const scroll = await drawer.locator('[data-page-view-content]').evaluate(element => element.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await sourceLink.click();
  await expect(page.getByRole('dialog', { name: 'Pilot source', exact: true })).toContainText('three integration paths');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(sourceLink).toBeFocused();
  await expect(draft).toHaveValue('Keep this unsaved note');
  expect(await draft.evaluate((element, original) => element === original, draftNode)).toBe(true);
  expect(await draft.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([2, 8]);
  expect(Math.abs(await drawer.locator('[data-page-view-content]').evaluate(element => element.scrollTop) - scroll)).toBeLessThanOrEqual(2);
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(trigger).toBeFocused();

  const metric = main.getByRole('link', { name: 'Options: 2' });
  await metric.click();
  const inline = main.getByRole('region', { name: 'Release options', exact: true });
  await expect(inline.getByText('Earlier feedback', { exact: true })).toBeVisible();
  expect(await inline.evaluate(element => element.closest('.michi-doc-block')?.getAttribute('data-block-id'))).toBe('metrics');
  const metricBox = await metric.boundingBox(), inlineBox = await inline.boundingBox();
  expect(inlineBox!.y).toBeGreaterThan(metricBox!.y + metricBox!.height);
  await page.screenshot({ animations: 'disabled', path: resolve(evidence, 'inline.png') });
  await inline.getByRole('button', { name: 'Close details', exact: true }).click();
  await expect(metric).toBeFocused();

  const compare = main.getByRole('link', { name: 'Compare options', exact: true });
  await compare.click();
  const modal = page.getByRole('dialog', { name: 'Release options', exact: true });
  await expect(modal).toHaveAttribute('aria-modal', 'true');
  await expect(modal.getByText('One transition', { exact: true })).toBeVisible();
  const detailBlock = modal.locator('.michi-doc-block[data-block-id="option-table"]');
  await detailBlock.hover();
  const tools = await detailBlock.getByRole('toolbar').boundingBox();
  const header = await modal.locator('.ui-overlay-header').boundingBox();
  expect(tools!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  await page.mouse.move(100, 900);
  await page.screenshot({ animations: 'disabled', path: resolve(evidence, 'modal.png') });
  await page.keyboard.press('Escape');
  await expect(compare).toBeFocused();
  await expect(modal).toHaveCount(0);

  // The same native content fits narrow panes; close remains visible and reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger.click();
  await expect(drawer.getByRole('button', { name: 'Close', exact: true })).toBeInViewport();
  const narrowBox = await drawer.boundingBox();
  expect(narrowBox!.x).toBeGreaterThanOrEqual(-1);
  expect(narrowBox!.width).toBeLessThanOrEqual(391);
  await page.screenshot({ animations: 'disabled', path: resolve(evidence, 'drawer-narrow.png') });
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
