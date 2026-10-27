import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';
import { COMPOSER_EDITOR } from '../fixtures/shell';

test('a late tool input snapshot stays visible after a later output-only update', async ({ page }) => {
  await installMockApi(page, { streamEvents: [
    { event: 'tool_call', data: { toolCallId: 'late-input', title: 'Read', status: 'running' } },
    { event: 'tool_call_update', data: { toolCallId: 'late-input', title: 'Read', status: 'running', inputJson: '{"file_path":"/tmp/late-input-evidence.md"}' } },
    { event: 'tool_call_update', data: { toolCallId: 'late-input', title: 'Read', status: 'completed', output: 'TOOL_RESULT_MARKER' } },
    { event: 'chunk', data: { text: 'The file was read.' } },
    { event: 'done', data: { stopReason: 'end_turn' } },
  ] });
  await bootWithWorkspace(page);
  await page.locator(COMPOSER_EDITOR).first().fill('Read the requested file');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect(page.getByText('The file was read.', { exact: true })).toBeVisible();
  // Expand the ordinary tool row; the path is present only in the late input.
  await page.getByText('/tmp/late-input-evidence.md', { exact: true }).click();
  await expect(page.locator('pre').filter({ hasText: '"file_path"' })).toContainText('/tmp/late-input-evidence.md');
  await expect(page.locator('pre').filter({ hasText: 'TOOL_RESULT_MARKER' })).toBeVisible();
});
