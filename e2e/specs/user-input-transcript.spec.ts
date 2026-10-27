import { test, expect } from '@playwright/test';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

test('consecutive question answers and skip remain in the transcript', async ({ page }) => {
  const responses: Array<{ requestId: number; answers?: unknown[]; skip?: boolean }> = [];
  await installMockApi(page, { custom: async route => {
    if (route.request().method() === 'POST' && new URL(route.request().url()).pathname.endsWith('/user-input-response')) {
      responses.push(route.request().postDataJSON());
      await route.fulfill({ json: { ok: true } });
      return true;
    }
    return false;
  } });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    (window as any).__inputTranscript = { seq: 0 };
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (init?.method === 'POST' && /\/chats\/[^/]+\/message$/.test(url.pathname)) {
        const audit = (window as any).__inputTranscript;
        audit.turnId = JSON.parse(String(init.body)).turnId;
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { audit.controller = controller; } }), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      return original(input, init);
    };
  });
  await bootWithWorkspace(page);
  await page.locator(COMPOSER_EDITOR).first().fill('Ask two questions');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!(window as any).__inputTranscript.controller)).toBe(true);
  const push = async (event: string, data: Record<string, unknown>) => page.evaluate(({ event, data }) => {
    const audit = (window as any).__inputTranscript;
    audit.controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify({ ...data, turnId: audit.turnId, seq: audit.seq++ })}\n\n`));
  }, { event, data });
  await push('user_input_request', { requestId: 1, interactionId: 'e2e:input:1', questions: [{ id: 'q1', question: 'Which color?', options: [{ label: 'Blue' }], multiSelect: false }] });
  await expect(page.getByRole('radiogroup', { name: 'Which color?' })).toBeVisible();
  await page.getByRole('radio', { name: 'Blue' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect.poll(() => responses.length).toBe(1);
  await expect(page.locator('.ask-resolved').getByText('Blue', { exact: true })).toBeVisible();
  await push('user_input_resolved', { requestId: 1, interactionId: 'e2e:input:1', answers: [{ id: 'q1', question: 'Which color?', answer: 'Blue' }], outcome: 'answered' });
  await push('user_input_request', { requestId: 2, interactionId: 'e2e:input:2', questions: [{ id: 'q2', question: 'Continue now?', options: [{ label: 'Continue' }], multiSelect: false }] });
  await expect(page.getByRole('radiogroup', { name: 'Continue now?' })).toBeVisible();
  await expect(page.locator('.ask-resolved').getByText('Blue', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect.poll(() => responses.length).toBe(2);
  await push('user_input_resolved', { requestId: 2, interactionId: 'e2e:input:2', answers: [], outcome: 'skipped' });
  await push('chunk', { text: 'Finished questions.' });
  await push('done', { stopReason: 'end_turn', persisted: true, completedAt: 100 });
  await expect(page.locator('.ask-resolved')).toHaveCount(2);
  await expect(page.locator('.ask-resolved').getByText('Which color?', { exact: true })).toBeVisible();
  await expect(page.locator('.ask-resolved').getByText('Continue now?', { exact: true })).toBeVisible();
  await expect(page.locator('.ask-resolved').getByText('(skipped)', { exact: true })).toBeVisible();
  expect(responses[0]).toMatchObject({ requestId: 1, answers: [{ id: 'q1', answer: 'Blue' }] });
  expect(responses[1]).toMatchObject({ requestId: 2, skip: true });
});
