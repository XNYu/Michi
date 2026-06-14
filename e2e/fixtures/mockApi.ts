import type { Page, Route } from '@playwright/test';
import { encodeChatStreamEvent, type ChatStreamEvent } from 'michi-shared';

// ── SSE helpers ──────────────────────────────────────────────────────────────
//
// Backend SSE format (see backend/src/routes and frontend/src/services/api.ts:
// streamMessage). Frame layout per event:
//
//   event: <name>\n
//   data: <json>\n
//   \n
//
// Frontend splits on `\n\n`, then strips `event:` / `data:` lines. We just
// concatenate frames into one body and let Playwright fulfill in a single
// chunk — the parser doesn't care whether bytes arrive at once or in chunks.

export type SseEvent = ChatStreamEvent;

export function sseBody(events: SseEvent[]): string {
  return events.map(encodeChatStreamEvent).join('');
}

export const defaultTurn: SseEvent[] = [
  { event: 'chunk', data: { text: 'Hello from mock kiro. ' } },
  { event: 'chunk', data: { text: 'This is a fake reply.' } },
  { event: 'title', data: { title: 'Mock turn' } },
  { event: 'follow_ups', data: { followUps: ['Tell me more', 'What else?', 'Stop'] } },
  { event: 'done', data: { stopReason: 'end_turn' } },
];

// ── Endpoint registry ────────────────────────────────────────────────────────
//
// Anything not listed here gets a generic `{}` 200 response so the app
// doesn't trip on an unmocked endpoint. Override anything you care about
// per-spec via `installMockApi(page, { overrides: { ... } })`.

export interface MockOverrides {
  /** Custom SSE timeline for POST /api/chats/:id/message. */
  streamEvents?: SseEvent[];
  /** Delay (ms) before SSE body is sent. Used by cancel-resume specs. */
  streamDelayMs?: number;
  /** Pre-seeded workspaces returned by GET /api/workspaces and /workspaces/all. */
  workspaces?: unknown[];
  /** Custom route handler. Called BEFORE built-ins — return true to short-circuit. */
  custom?: (route: Route) => Promise<boolean>;
}

let chatIdCounter = 0;
function nextChatId() {
  chatIdCounter += 1;
  return `mock-chat-${chatIdCounter}`;
}

export async function installMockApi(page: Page, overrides: MockOverrides = {}) {
  chatIdCounter = 0;

  await page.route('**/api/**', async (route) => {
    if (overrides.custom && (await overrides.custom(route))) return;

    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const method = route.request().method();

    // ── SSE stream ───────────────────────────────────────────────────────
    if (method === 'POST' && /^\/chats\/[^/]+\/message$/.test(path)) {
      if (overrides.streamDelayMs) {
        await new Promise((r) => setTimeout(r, overrides.streamDelayMs));
      }
      const body = sseBody(overrides.streamEvents ?? defaultTurn);
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'cache-control': 'no-cache' },
        body,
      });
    }

    // ── JSON endpoints ───────────────────────────────────────────────────
    const json = (data: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });

    // chat create
    if (method === 'POST' && path === '/chats') {
      return json({ chatId: nextChatId(), currentModeId: null });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/load$/.test(path)) {
      return json({ currentModeId: null });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/cancel$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/claim$/.test(path)) {
      return json({ owner: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/heartbeat$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/release$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/chats\/[^/]+\/set-(mode|model)$/.test(path)) {
      return json({ currentModeId: null, currentModelId: 'mock-model' });
    }

    // workspaces
    if (method === 'GET' && (path === '/workspaces' || path === '/workspaces/all')) {
      return json({ workspaces: overrides.workspaces ?? [] });
    }
    if (method === 'POST' && /^\/workspaces\/[^/]+\/sync$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'DELETE' && /^\/workspaces\/[^/]+$/.test(path)) {
      return json({ ok: true });
    }

    // nodes
    if (method === 'POST' && /^\/nodes\/[^/]+\/ensure-session$/.test(path)) {
      let requestBody: { chatId?: unknown } = {};
      try {
        requestBody = route.request().postDataJSON() as { chatId?: unknown };
      } catch {
        requestBody = {};
      }
      const existingChatId = typeof requestBody.chatId === 'string' ? requestBody.chatId : null;
      return json({
        chatId: existingChatId ?? nextChatId(),
        currentModeId: null,
        resumeStrategy: existingChatId ? 'live' : 'fresh',
      });
    }
    if (method === 'PATCH' && /^\/nodes\/[^/]+$/.test(path)) {
      return json({ ok: true });
    }
    if (method === 'POST' && /^\/nodes\/[^/]+\/messages$/.test(path)) {
      return json({ ok: true });
    }

    // bootstrap
    if (path === '/agent/status') {
      return json({
        runtime: 'mock',
        label: 'Mock Runtime',
        capabilities: {
          modes: false,
          permissions: false,
          providerModels: false,
          reasoning: false,
          apiKeys: false,
          warmSessions: false,
          saveContext: false,
          spawnBranches: false,
        },
        availableRuntimes: [{ id: 'mock', label: 'Mock Runtime', available: true }],
        hasRequiredKey: true,
      });
    }
    if (path === '/modes') return json({ availableModes: [] });
    if (path === '/models') return json({ models: [], default_model: null });
    if (path === '/agent/models') return json({ models: [] });
    if (path === '/version') {
      return json({
        localHash: 'mock',
        localDate: '2026-01-01',
        remoteHash: null,
        remoteName: null,
        updateAvailable: false,
      });
    }
    if (method === 'POST' && path === '/warm') return json({ ok: true });
    if (method === 'POST' && path === '/migrate') return json({ migrated: false });

    // Default: empty 200. Loud enough to find in traces if we missed something.
    return json({ __unmocked: path });
  });
}

// ── App boot helpers ─────────────────────────────────────────────────────────

/**
 * Boot the app, dismiss the auto-opened "create workspace" dialog by creating
 * a default workspace with no cwd. Returns when the chat composer is visible.
 */
export async function bootWithWorkspace(page: Page, name = 'E2E Workspace') {
  await page.goto('/');

  // The new-workspace dialog auto-opens when there are no projects.
  // NewWorkspaceDialog has: <input placeholder="Untitled workspace"> + <button>Create</button>.
  const nameInput = page.getByPlaceholder(/workspace|untitled/i).first();
  await nameInput.waitFor({ state: 'visible', timeout: 10_000 });
  await nameInput.fill(name);
  await page.getByRole('button', { name: /^create$/i }).click();

  // Wait for chat composer to be focusable (textarea inside MentionTextarea).
  await page.locator('textarea').first().waitFor({ state: 'visible', timeout: 10_000 });
}
