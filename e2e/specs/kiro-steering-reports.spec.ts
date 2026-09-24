import { test, expect } from '@playwright/test';
import { KiroSteeringParser } from '../../shared/src/kiroSteering';
import { installMockApi, bootWithWorkspace, sseBody } from '../fixtures/mockApi';

const report = { messageId: 'steer-c3999cf6ce9f462cb72019fcc3fb5368', text: 'Changed the recommendation from blue to cobalt after the additional constraint.', complete: true };
const marker = `[STEERING ${report.messageId}: ${report.text}]`;

test('streamed Kiro reports render as model notes, never raw markers, on desktop and mobile', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await installMockApi(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (/\/chats\/[^/]+\/message$/.test(url)) {
        return new Response(new ReadableStream({ start(controller) {
          (window as any).__steeringFrame = (frame: string) => controller.enqueue(new TextEncoder().encode(frame));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return original(input, init);
    };
  });
  await bootWithWorkspace(page, 'Kiro steering notes');
  await page.locator('[contenteditable="true"]').first().fill('Compare the colors and consider my added constraint.');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__steeringFrame)).toBe('function');
  const parser = new KiroSteeringParser();
  const send = async (text: string) => {
    const frames = parser.push(text).map((segment) => segment.kind === 'text'
      ? { event: 'chunk', data: { text: segment.text } }
      : { event: 'steering_report', data: { reports: [segment.report], source: 'model', confidence: 'unverified' } });
    await page.evaluate((body) => (window as any).__steeringFrame(body), sseBody(frames));
    await expect(page.locator('.terminal-message-assistant')).not.toContainText('[STEER');
  };
  await send('Cobalt keeps the calm character of blue while giving the interface a more distinctive accent.\n\n[STEER');
  await expect(page.getByText(/Cobalt keeps the calm/).first()).toBeVisible();
  await send(marker.slice(6, -1));
  await expect(page.locator('.t-steering-reports')).toHaveCount(0);
  await send(']');
  const notes = page.locator('.t-steering-reports');
  await expect(notes.locator('summary')).toBeVisible();
  await expect(notes).not.toHaveAttribute('open');
  await expect(notes).not.toContainText(report.messageId);
  // Test native keyboard activation before completion refocuses the composer.
  await notes.locator('summary').press('Enter');
  await expect(notes).toHaveAttribute('open', '');
  await page.evaluate((body) => (window as any).__steeringFrame(body), sseBody([{ event: 'done', data: { stopReason: 'end_turn' } }]));
  await expect(page.getByRole('button', { name: 'Stop stream', exact: true })).toHaveCount(0);
  await expect(notes.getByText(report.text)).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(notes).toBeVisible();
    await expect.poll(async () => {
      const bounds = await notes.boundingBox();
      return bounds ? bounds.x + bounds.width : Infinity;
    }).toBeLessThanOrEqual(width + 1);
    expect(await notes.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`kiro-steering-notes-${width}.png`), animations: 'disabled' });
  }
  await notes.locator('summary').click();
  await expect(notes.getByText(report.text)).not.toBeVisible();
  expect(errors).toEqual([]);
});

for (const legacy of [false, true]) {
  test(`${legacy ? 'legacy text' : 'structured metadata'} survives reload without exposing native markers`, async ({ page }) => {
    const text = 'Cobalt is the selected color.';
    const workspace = {
      workspace: { id: 'steering-ws', name: 'Steering history', active_tree_id: 'steering-tree', created_at: 1 },
      trees: [{ id: 'steering-tree', workspace_id: 'steering-ws', root_node_id: 'steering-node', name: 'Color choice', created_at: 1, last_active_at: 1 }],
      nodes: [{ id: 'steering-node', workspace_id: 'steering-ws', tree_id: 'steering-tree', kind: 'chat', title: 'Color choice', runtime_id: 'kiro', status: 'idle', created_at: 1 }],
      edges: [], contexts: [], messages: [{ id: 'answer', node_id: 'steering-node', role: 'assistant', seq: 1,
        content: legacy ? `${text}\n\n${marker}` : text,
        blocks: legacy ? undefined : JSON.stringify([{ id: 'b', kind: 'answer', rawText: text }]),
        metadata: legacy ? undefined : JSON.stringify({ steeringReports: [report] }),
      }],
    };
    await installMockApi(page, { workspaces: [workspace] });
    await page.addInitScript(() => localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false })));
    await page.goto('/');
    await page.locator('.terminal-sidebar [data-sidebar-row="steering-node"]').click();
    for (let pass = 0; pass < 2; pass++) {
      const notes = page.locator('.t-steering-reports');
      await expect(notes.locator('summary')).toBeVisible();
      await expect(page.locator('.terminal-message-assistant')).toContainText(text);
      await expect(page.locator('.terminal-message-assistant')).not.toContainText('[STEERING');
      await notes.locator('summary').click();
      await expect(notes.getByText(report.text)).toBeVisible();
      await expect(page.locator('.terminal-dashboard')).not.toContainText(report.messageId);
      if (pass === 0) {
        await page.reload();
        // The shell boots to Home; reopening the thread exercises hydration.
        await page.locator('.terminal-sidebar [data-sidebar-row="steering-node"]').click();
      }
    }
  });
}
