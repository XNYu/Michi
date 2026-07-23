import { test, expect, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

// Pane scroll restore behavior (TPane mount positioning):
//   1. First open on a device (no saved anchor) → bottom.
//   2. Already-read chat → reopens at the exact position it was left.
//   3. Chat with messages newer than the saved lastSeen horizon → first
//      unseen message parked at ~30% of the viewport height.
//
// State is seeded through localStorage (michi:v1:state) exactly like the
// pane-performance suite; every /api call is intercepted by mockApi.

const STATE_SCHEMA_VERSION = 5;
const PROJECT_ID = 'scroll-ws';
const TURNS = 10;
const BASE_T = 1_780_000_000_000;

function longAnswer(chat: string, turn: number): string {
  const para = `Chat ${chat} turn ${turn}: this paragraph pads the transcript so the pane must scroll. `;
  return [
    `### Chat ${chat} — turn ${turn}`,
    '',
    para.repeat(12),
    '',
    para.repeat(12),
    '',
    para.repeat(12),
  ].join('\n');
}

function makeChatNode(nodeId: string, chat: string, turns: number) {
  const messages = [] as unknown[];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({
      id: `u-${nodeId}-${turn}`,
      role: 'user',
      text: `Question ${turn} for chat ${chat}, with enough words to wrap onto a couple of lines in the pane.`,
      toolCalls: [],
      createdAt: BASE_T + turn * 1_000,
    });
    messages.push({
      id: `a-${nodeId}-${turn}`,
      role: 'assistant',
      text: '',
      toolCalls: [],
      blocks: [{ id: `b-${nodeId}-${turn}`, kind: 'answer', rawText: longAnswer(chat, turn) }],
      streaming: false,
      createdAt: BASE_T + turn * 1_000 + 500,
    });
  }
  return {
    nodeId,
    kind: 'chat',
    chatId: `mock-chat-${nodeId}`,
    runtimeId: 'mock',
    projectId: PROJECT_ID,
    messages,
    // Follow-ups present on purpose — the historical failure mode pinned
    // every followUps-bearing pane to the bottom on open.
    followUps: [`More about ${chat}?`, `Summarize ${chat}?`, `Branch ${chat}?`],
    followUpsSourceMessageId: `a-${nodeId}-${turns - 1}`,
    title: `Chat ${chat}`,
    status: 'idle',
    viewedAt: BASE_T + turns * 1_000,
    lastAssistantAt: BASE_T + (turns - 1) * 1_000 + 500,
  };
}

function makeSavedState() {
  const nodes = {
    nA: makeChatNode('nA', 'A', TURNS),
    nB: makeChatNode('nB', 'B', 2),
  };
  return {
    version: STATE_SCHEMA_VERSION,
    activeProjectId: PROJECT_ID,
    projects: [{
      id: PROJECT_ID,
      name: 'Scroll Restore WS',
      chatIds: ['nA', 'nB'],
      edges: [],
      trees: [
        { id: 'tree-a', rootNodeId: 'nA', createdAt: BASE_T, lastActiveAt: BASE_T + 100 },
        { id: 'tree-b', rootNodeId: 'nB', createdAt: BASE_T, lastActiveAt: BASE_T + 50 },
      ],
      activeTreeId: 'tree-a',
      contexts: [],
      createdAt: BASE_T,
    }],
    nodes,
  };
}

async function seed(page: Page, scrollAnchors?: unknown) {
  await page.addInitScript(({ state, anchors }) => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('michi:migrated', '1');
    window.localStorage.setItem('michi:v1:state', JSON.stringify(state));
    if (anchors) {
      window.localStorage.setItem('michi:paneScrollAnchors', JSON.stringify(anchors));
    }
  }, { state: makeSavedState(), anchors: scrollAnchors ?? null });
  await installMockApi(page);
}

const paneScroller = (page: Page, nodeId: string) =>
  page.locator(`[data-node-id="${nodeId}"] .term-scrollbar`).first();

interface ScrollProbe {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distFromBottom: number;
  /** data-msg-id of the topmost (partly) visible message. */
  topMsgId: string | null;
  /** topmost message's top edge relative to the viewport top, px. */
  topMsgOffset: number;
}

async function probe(page: Page, nodeId: string): Promise<ScrollProbe> {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-node-id="${id}"] .term-scrollbar`) as HTMLElement;
    const viewTop = el.getBoundingClientRect().top;
    let topMsgId: string | null = null;
    let topMsgOffset = 0;
    for (const f of Array.from(el.querySelectorAll<HTMLElement>('[data-msg-id]'))) {
      const r = f.getBoundingClientRect();
      if (r.bottom > viewTop + 1) {
        topMsgId = f.getAttribute('data-msg-id');
        topMsgOffset = r.top - viewTop;
        break;
      }
    }
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
      topMsgId,
      topMsgOffset,
    };
  }, nodeId);
}

async function openChat(page: Page, title: string, nodeId: string) {
  await page.getByText(title, { exact: true }).first().click();
  await page.locator(`[data-node-id="${nodeId}"] [data-msg-id]`).first().waitFor({ timeout: 10_000 });
  // Let the mount settle loop and content-visibility inflation finish.
  await page.waitForTimeout(900);
}

test.describe('pane scroll restore', () => {
  test('first open lands at the bottom; reopening restores the left-off position', async ({ page }) => {
    await seed(page);
    await page.goto('/');

    // ── First open: no saved anchor → bottom ────────────────────────────
    await openChat(page, 'Chat A', 'nA');
    const first = await probe(page, 'nA');
    expect(first.scrollHeight).toBeGreaterThan(first.clientHeight * 3); // long enough to be meaningful
    expect(first.distFromBottom).toBeLessThan(200);

    // ── Scroll up into the middle of the history ────────────────────────
    await page.evaluate(() => {
      const el = document.querySelector('[data-node-id="nA"] .term-scrollbar') as HTMLElement;
      const msg = el.querySelector('[data-msg-id="u-nA-5"]') as HTMLElement;
      el.scrollTop += msg.getBoundingClientRect().top - el.getBoundingClientRect().top - 40;
    });
    await page.waitForTimeout(600); // debounced save (250ms) + slack
    const before = await probe(page, 'nA');
    expect(before.topMsgId).not.toBeNull();
    expect(before.distFromBottom).toBeGreaterThan(400);

    // ── Switch to another chat (pane A unmounts and saves) ──────────────
    await openChat(page, 'Chat B', 'nB');
    await expect(page.locator('[data-node-id="nA"]')).toHaveCount(0);

    // ── Reopen: must land where we left, not at the bottom ──────────────
    await openChat(page, 'Chat A', 'nA');
    const after = await probe(page, 'nA');
    expect(after.topMsgId).toBe(before.topMsgId);
    expect(Math.abs(after.topMsgOffset - before.topMsgOffset)).toBeLessThan(48);
    expect(after.distFromBottom).toBeGreaterThan(400);
  });

  test('unread chat opens with the first unseen message at ~30% viewport height', async ({ page }) => {
    // Saved horizon: everything up to turn 6 has been seen. Turns 7..9
    // (user msg u-nA-7 first) landed "while the pane was closed".
    const lastSeen = BASE_T + 6 * 1_000 + 500;
    await seed(page, [[
      'nA',
      { anchorId: 'u-nA-3', offset: -20, atBottom: false, lastSeen },
    ]]);
    await page.goto('/');

    await openChat(page, 'Chat A', 'nA');
    const p = await probe(page, 'nA');

    // The first unseen message sits at upper-middle: ~30% of the viewport
    // height from the top (generous tolerance for content-visibility drift).
    const unseenTop = await page.evaluate(() => {
      const el = document.querySelector('[data-node-id="nA"] .term-scrollbar') as HTMLElement;
      const msg = el.querySelector('[data-msg-id="u-nA-7"]') as HTMLElement;
      return msg.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect(Math.abs(unseenTop - p.clientHeight * 0.3)).toBeLessThan(64);
    // And we are neither at the bottom nor at the saved anchor.
    expect(p.distFromBottom).toBeGreaterThan(200);
  });

  test('read chat with saved mid-history anchor reopens at that anchor', async ({ page }) => {
    // lastSeen equals the newest message → nothing unseen → anchor restore.
    const lastSeen = BASE_T + (TURNS - 1) * 1_000 + 500;
    await seed(page, [[
      'nA',
      { anchorId: 'u-nA-4', offset: -20, atBottom: false, lastSeen },
    ]]);
    await page.goto('/');

    await openChat(page, 'Chat A', 'nA');
    const p = await probe(page, 'nA');
    expect(p.topMsgId).toBe('u-nA-4');
    expect(Math.abs(p.topMsgOffset - (-20))).toBeLessThan(48);
  });
});
