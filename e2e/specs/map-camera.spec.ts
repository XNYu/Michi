import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// Map camera: default framing (small graphs enlarge, larger graphs frame the
// root + its first three branches) and cursor-anchored pinch zoom that never
// re-renders cards.

type Shape = { branches: number; depth: number };

async function boot(page: Page, shape: Shape) {
  await installMockApi(page);
  await page.addInitScript(({ branches, depth }) => {
    localStorage.clear(); sessionStorage.clear();
    const ids = ['root'];
    const edges: { source: string; target: string; kind: string }[] = [];
    for (let b = 0; b < branches; b++) {
      let parent = 'root';
      for (let d = 1; d <= depth; d++) {
        const id = `b${b}d${d}`;
        ids.push(id);
        edges.push({ source: parent, target: id, kind: 'branch' });
        parent = id;
      }
    }
    // Realistic cards: an ASKED ribbon, a long title and a two-line summary,
    // so measured heights differ from the layout estimate.
    const nodes = Object.fromEntries(ids.map((id) => [id, {
      nodeId: id, kind: 'chat', chatId: null, projectId: 'cam-ws',
      title: id === 'root' ? 'root conversation' : `${id} conversation about workspace branching`,
      status: 'idle', followUps: [],
      messages: [
        { id: `${id}-q`, role: 'user', text: `How does ${id} relate to the rest of the workspace and its branches?`, toolCalls: [], createdAt: 1 },
        { id: `${id}-a`, role: 'assistant', text: 'ok', toolCalls: [], createdAt: 2 },
      ],
      branchOverviewEntries: [{ at: 3, text: `Explained how ${id} inherits context from its parent and which files it touched while exploring the branching model.` }],
    }]));
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:v1:state', JSON.stringify({ version: 6, activeProjectId: 'cam-ws', nodes, projects: [{
      id: 'cam-ws', name: 'Camera', chatIds: ids, edges,
      trees: [{ id: 'tree', rootNodeId: 'root', name: 'root conversation', createdAt: 1, lastActiveAt: 1 }],
      activeTreeId: 'tree', contexts: [], createdAt: 1,
    }] }));
  }, shape);
  await page.goto('/');
  await page.getByText('root conversation', { exact: true }).first().click();
  await page.keyboard.press('ControlOrMeta+m');
  await expect(card(page, 'root')).toBeVisible();
  // Let ELK (async) settle and any auto re-frame tween finish.
  await page.waitForTimeout(600);
}

function card(page: Page, id: string) {
  return page.locator(`[data-map-world] > [data-map-node="${id}"]`);
}

function scale(page: Page) {
  return page.locator('[data-map-world]').evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
}

async function onScreen(page: Page, id: string) {
  const surface = (await page.locator('[data-map-surface]').boundingBox())!;
  const box = (await card(page, id).boundingBox())!;
  return box.x < surface.x + surface.width && box.x + box.width > surface.x
    && box.y < surface.y + surface.height && box.y + box.height > surface.y;
}

async function fullyOnScreen(page: Page, id: string) {
  const surface = (await page.locator('[data-map-surface]').boundingBox())!;
  const box = (await card(page, id).boundingBox())!;
  return box.x >= surface.x && box.x + box.width <= surface.x + surface.width
    && box.y >= surface.y && box.y + box.height <= surface.y + surface.height;
}

test.use({ viewport: { width: 1440, height: 900 } });

test('a small graph is enlarged past 100%', async ({ page }) => {
  await boot(page, { branches: 1, depth: 1 });
  const k = await scale(page);
  expect(k).toBeGreaterThan(1);
  expect(k).toBeLessThanOrEqual(1.35);
});

test('a bushy root frames itself and its first three branches', async ({ page }) => {
  await boot(page, { branches: 7, depth: 2 });
  expect(await scale(page)).toBeGreaterThanOrEqual(0.8);
  for (const id of ['root', 'b0d1', 'b1d1', 'b2d1']) {
    expect(await fullyOnScreen(page, id), id).toBe(true);
  }
  // Later branches are reached by panning.
  expect(await onScreen(page, 'b5d1')).toBe(false);
  expect(await onScreen(page, 'b6d1')).toBe(false);
});

test('a linear thread starts at the root and keeps text readable', async ({ page }) => {
  await boot(page, { branches: 1, depth: 7 });
  // Four cards in a row don't fit 1160px at the readable floor, so the view
  // keeps the floor and pins the root to the left instead of shrinking.
  expect(await scale(page)).toBeGreaterThanOrEqual(0.8);
  for (const id of ['root', 'b0d1', 'b0d2']) {
    expect(await fullyOnScreen(page, id), id).toBe(true);
  }
  expect(await onScreen(page, 'b0d5')).toBe(false);
});

test('measured card heights keep cards from overlapping', async ({ page }) => {
  await boot(page, { branches: 4, depth: 2 });
  const boxes = await page.locator('[data-map-world] > [data-map-node]').evaluateAll((els) =>
    els.map((el) => {
      // The wrapper box is the layout box; the card inside is the real content.
      const card = (el.firstElementChild as HTMLElement).getBoundingClientRect();
      return { id: el.getAttribute('data-map-node'), top: card.top, bottom: card.bottom, left: card.left, right: card.right };
    }));
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i]; const b = boxes[j];
    if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlaps.push(`${a.id}/${b.id}`);
  }
  expect(overlaps).toEqual([]);
});

test('pinch zoom is anchored at the cursor and stays on the compositor', async ({ page }) => {
  await boot(page, { branches: 3, depth: 4 });
  const root = (await card(page, 'root').boundingBox())!;
  const cursor = { x: root.x + root.width * 0.25, y: root.y + root.height * 0.5 };
  // Fraction of the card under the cursor before zooming.
  const fx = (cursor.x - root.x) / root.width;

  const result = await page.evaluate(async ({ x, y }) => {
    const surface = document.querySelector<HTMLElement>('[data-map-surface]')!;
    const world = document.querySelector<HTMLElement>('[data-map-world]')!;
    // Any React commit of the graph would touch card attributes; watch for it.
    let mutations = 0;
    const mo = new MutationObserver((records) => {
      mutations += records.filter((r) => r.target !== world).length;
    });
    mo.observe(world, { subtree: true, attributes: true, childList: true });
    const deltas: number[] = [];
    let last = performance.now();
    for (let i = 0; i < 60; i++) {
      surface.dispatchEvent(new WheelEvent('wheel', {
        deltaY: i < 30 ? -4 : 2, ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true,
      }));
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      deltas.push(now - last);
      last = now;
    }
    const willChange = world.style.willChange;
    mo.disconnect();
    deltas.sort((a, b) => a - b);
    return { mutations, willChange, p95: deltas[Math.floor(deltas.length * 0.95)] };
  }, cursor);

  expect(result.willChange).toBe('transform');
  expect(result.mutations).toBe(0);
  expect(result.p95).toBeLessThan(40);
  console.log(`[map-camera] pinch frame p95=${result.p95.toFixed(1)}ms`);

  const after = (await card(page, 'root').boundingBox())!;
  expect(after.width).toBeGreaterThan(root.width);
  // Same point of the card is still under the cursor.
  expect(Math.abs(after.x + after.width * fx - cursor.x)).toBeLessThan(2);
  await expect(page.locator('[data-map-world]')).toHaveCSS('will-change', 'auto');
  await expect(page.getByTitle('fit map to the visible area')).not.toHaveClass(/is-active/);
});
