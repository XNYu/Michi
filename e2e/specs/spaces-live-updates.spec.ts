import { expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SseEvent } from '../fixtures/mockApi';
import { installMockApi } from '../fixtures/mockApi';
import { openArea } from '../fixtures/shell';
import { controlledStreamState, installControlledChatStream, pushChatStream } from '../fixtures/controlledChatStream';
import { createSpacesLiveUpdatesMock, liveAssistant, liveWorkspace, LIVE_ASSISTANT_ID, LIVE_HOME_ID, LIVE_PAGE_ID, pageWriteOutput } from '../fixtures/spacesLiveUpdatesFixtures';

const evidence = resolve('.artifacts/spaces-live-updates');
const prompt = 'Update the release status, then check the next action.';
const draftText = 'My unsaved review note stays here.';

for (const scenario of [
  { kind: 'workspace-home', pageId: LIVE_HOME_ID, title: 'Release work', ending: 'failed' },
  { kind: 'space', pageId: LIVE_PAGE_ID, title: 'Live release', ending: 'cancelled' },
] as const) {
  test(`${scenario.kind}: committed tool A renders midstream and survives tool B ${scenario.ending}`, async ({ page }) => {
    mkdirSync(evidence, { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 1720, height: 1080 });
    await page.addInitScript(() => {
      localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, terminalPalette: 'bone', uiFont: 'Geist' }));
      localStorage.setItem('michi:migrated', '1');
    });
    const mock = createSpacesLiveUpdatesMock();
    await installControlledChatStream(page);
    await installMockApi(page, { workspaces: [liveWorkspace, liveAssistant], custom: mock.handle });
    await page.goto('/');
    await expect(page.locator('.home-page')).toBeVisible();
    await openArea(page, 'spaces');
    await page.locator('.spaces-side').getByRole('button', { name: 'Release work', exact: true }).click();
    if (scenario.kind === 'space') {
      await page.locator('.spaces-home-space-card').filter({ hasText: 'Live release' }).click();
    }
    const main = page.getByRole('main', { name: scenario.title, exact: true });
    const status = main.locator('[data-block-id="live-status"]');
    await expect(status).toContainText('Release status: draft.');

    const panel = page.getByRole('region', { name: 'Assistant', exact: true });
    const launcher = page.locator('button.meta-chat-pill');
    await panel.or(launcher).first().waitFor();
    if (!await panel.isVisible()) await launcher.click();
    await expect(panel).toContainText(`Viewing: ${scenario.title}`);
    await panel.locator('.terminal-composer [contenteditable="true"]').fill(prompt);
    await panel.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
    await expect.poll(async () => (await controlledStreamState(page)).requests.length).toBe(1);
    const request = (await controlledStreamState(page)).requests[0];
    expect(request.body.metaAgentContext).toMatchObject({ pageId: scenario.pageId });
    const turnId = String(request.body.turnId);
    expect(turnId).not.toBe('undefined');
    const envelope = { turnId, assistantId: 'live-answer', nodeId: LIVE_ASSISTANT_ID };
    const frame = (event: SseEvent['event'], seq: number, data: Record<string, unknown>): SseEvent => ({ event, data: { ...envelope, seq, ...data } }) as SseEvent;
    await pushChatStream(page, [
      frame('turn_start', 1, { userText: prompt }),
      frame('chunk', 2, { text: 'Working on the release. ' }),
      frame('tool_call', 3, { toolCallId: 'tool-a', title: 'edit_page', status: 'in_progress', inputJson: JSON.stringify({ pageId: scenario.pageId }) }),
    ]);
    await expect(panel).toContainText('Working on the release.');
    await panel.getByRole('button', { name: 'Minimize', exact: true }).click();
    const working = launcher.getByRole('status', { name: 'Assistant is working' });
    await expect(working).toBeVisible();

    // Real per-block React state and a real unsaved editor must survive refetches.
    const timeline = main.locator('[data-block-id="timeline"]');
    await timeline.getByRole('button', { name: 'View all 10', exact: true }).click();
    await expect(timeline.locator('[data-michi-block="timeline"] li')).toHaveCount(10);
    const note = main.locator('[data-block-id="draft-note"]');
    await note.hover();
    await note.getByRole('button', { name: 'Edit', exact: true }).click();
    const draft = main.getByRole('textbox', { name: 'Edit Private review note', exact: true });
    await draft.fill(draftText);
    await main.evaluate(element => { element.scrollTop = 96; });
    await draft.evaluate(element => {
      const input = element as HTMLTextAreaElement;
      input.focus({ preventScroll: true });
      input.setSelectionRange(3, 12);
    });
    const draftElement = await draft.elementHandle();
    const scrollTop = await main.evaluate(element => element.scrollTop);
    expect(scrollTop).toBeGreaterThan(0);
    const retained = async () => {
      await expect(draft).toHaveValue(draftText);
      await expect(draft).toBeFocused();
      expect(await draft.evaluate((element, original) => element === original, draftElement)).toBe(true);
      expect(await draft.evaluate(element => [(element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([3, 12]);
      await expect(timeline.getByRole('button', { name: 'Show fewer', exact: true })).toHaveAttribute('aria-expanded', 'true');
      await expect(timeline.locator('[data-michi-block="timeline"] li')).toHaveCount(10);
      expect(Math.abs(await main.evaluate(element => element.scrollTop) - scrollTop)).toBeLessThanOrEqual(2);
    };

    // First read deliberately lags behind the committed receipt. Hold it to
    // prove the refresh itself does not turn the document read-only or remount it.
    const original = structuredClone(mock.pages.get(scenario.pageId)!);
    const savedA = mock.commit(scenario.pageId, 'Release status: QA approved.');
    mock.queueRead(scenario.pageId, original);
    mock.holdNextRead(scenario.pageId);
    const completionA = frame('tool_call_update', 4, { toolCallId: 'tool-a', title: '', status: 'completed', output: pageWriteOutput(savedA) });
    const receiptAt = Date.now();
    await pushChatStream(page, [completionA]);
    await expect.poll(() => mock.hasHeldRead(), { timeout: 3_000 }).toBe(true);
    await retained();
    await expect(draft).toBeEditable();
    await mock.releaseRead();
    // The 10-second background polling interval cannot satisfy this assertion.
    await expect(status).toContainText('Release status: QA approved.', { timeout: 3_000 });
    const visibleAfterMs = Date.now() - receiptAt;
    expect(visibleAfterMs).toBeLessThan(5_000);
    await expect(working).toBeVisible();
    expect((await controlledStreamState(page)).closed).toBe(false);
    await retained();
    await page.screenshot({ animations: 'disabled', path: resolve(evidence, `${scenario.kind}-a-streaming.png`) });

    // Transport duplicates, out-of-order frames and a newer envelope carrying
    // an older committed view must never roll the rendered document back.
    await pushChatStream(page, [
      completionA,
      frame('tool_call_update', 3, { toolCallId: 'tool-a', title: '', status: 'completed', output: pageWriteOutput(original) }),
      frame('tool_call_update', 5, { toolCallId: 'tool-a', title: '', status: 'completed', output: pageWriteOutput(savedA) }),
      frame('tool_call', 6, { toolCallId: 'tool-old', title: 'edit_page', status: 'in_progress' }),
      frame('tool_call_update', 7, { toolCallId: 'tool-old', title: '', status: 'completed', output: pageWriteOutput(original) }),
      frame('chunk', 8, { text: 'A is saved. Checking the next action. ' }),
      frame('tool_call', 9, { toolCallId: 'tool-b', title: 'edit_page', status: 'in_progress' }),
    ]);
    await expect(page.locator('section.meta-chat-panel')).toContainText('Checking the next action.');
    await expect(status).toContainText('Release status: QA approved.');
    await retained();

    if (scenario.ending === 'failed') {
      await pushChatStream(page, [
        frame('tool_call_update', 10, { toolCallId: 'tool-b', title: '', status: 'failed', output: pageWriteOutput({ ...savedA, revision: 3, viewVersion: 3 }, 'rejected') }),
        frame('chunk', 11, { text: 'The next action could not be changed; the saved QA status is intact.' }),
        frame('done', 12, { stopReason: 'end_turn', persisted: true }),
      ], true);
    } else {
      // A backend cancellation terminal is delivered while B is still active.
      await pushChatStream(page, [frame('done', 10, { stopReason: 'cancelled', persisted: true })], true);
    }
    await expect(working).toHaveCount(0);
    await expect(status).toContainText('Release status: QA approved.');
    await expect(status).not.toContainText('Release status: draft.');
    await retained();
    expect((await controlledStreamState(page)).closed).toBe(true);
    expect(mock.pages.get(scenario.pageId)?.viewVersion).toBe(2);
    expect(errors).toEqual([]);
    await page.screenshot({ animations: 'disabled', path: resolve(evidence, `${scenario.kind}-b-${scenario.ending}.png`) });
    writeFileSync(resolve(evidence, `${scenario.kind}-receipt.json`), JSON.stringify({
      scenario, visibleAfterMs, savedRevision: savedA.revision, savedViewVersion: savedA.viewVersion,
      streamOpenWhenAVisible: true, toolCompletionTitle: '', pageReads: mock.reads,
      retained: { expandedTimelineItems: 10, draft: draftText, selection: [3, 12], scrollTop, sameEditorNode: true },
      errors,
    }, null, 2));
  });
}
