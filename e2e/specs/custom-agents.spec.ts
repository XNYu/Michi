import { expect, test } from '@playwright/test';
import { bootWithWorkspace, createCustomAgentsMockController, installMockApi } from '../fixtures/mockApi';

test.describe('Custom Agents release flow', () => {
  test('definition → primary Agent → durable Runs → conversion actions', async ({ page }) => {
    test.setTimeout(60_000);
    const agents = createCustomAgentsMockController();
    await installMockApi(page, {
      custom: (route) => agents.handle(route),
      streamEvents: [
        { event: 'turn_start', data: { turnId: 'turn-e2e', assistantId: 'assistant-e2e', nodeId: 'mock-parent-node', userText: 'Delegate the work', startedAt: 1 } },
        { event: 'chunk', data: { text: 'I delegated two durable Agent Runs.' } },
        { event: 'done', data: { stopReason: 'end_turn', persisted: true, completedAt: 2 } },
      ],
    });
    await bootWithWorkspace(page, 'Custom Agents E2E');

    await page.keyboard.press('Meta+K');
    await page.getByText('Open Agent Library', { exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Agent Library' })).toBeVisible();
    await page.getByRole('button', { name: '+ workspace agent' }).click();
    await page.getByLabel('agent name').fill('E2E Implementer');
    await page.getByLabel('agent description').fill('Runs hermetic release checks.');
    await page.getByLabel('runtime runtime').selectOption('mock');
    await page.getByLabel('runtime provider').fill('mock');
    await page.getByLabel('runtime model').fill('flash');
    await page.getByLabel('agent instructions').fill('Complete the bounded task and report evidence.');
    await page.getByRole('button', { name: 'Enable' }).click();
    await expect(page.getByText('enabled', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'close' }).click();
    await page.keyboard.press('Meta+K');
    await page.getByText('Go to home', { exact: true }).click();
    const switchAgent = page.locator('[title*="Switch agent"]').first();
    await switchAgent.click();
    await page.getByText('E2E Implementer', { exact: true }).click();
    await expect(page.locator('[title="Switch agent — E2E Implementer"]')).toBeVisible();

    const composer = page.locator('[contenteditable="true"]').first();
    await composer.fill('Delegate the work');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect(page.getByText('I delegated two durable Agent Runs.')).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => agents.ensureSessionBodies.some((body) => body.agentDefinitionId === 'agent-e2e')).toBe(true);

    const savedCard = page.getByTestId('agent-run-card').filter({ hasText: 'Saved Definition Run' });
    const ephemeralCard = page.getByTestId('agent-run-card').filter({ hasText: 'Ephemeral fallback Run' });
    await expect(savedCard).toBeVisible();
    await expect(savedCard.getByText('Saved Agent completed')).toBeVisible();
    await expect(ephemeralCard).toBeVisible();
    await ephemeralCard.getByRole('button', { name: 'Open →' }).click();

    await expect(page.getByTestId('agent-run-pane')).toBeVisible();
    await expect(page.getByText('mock capacity fallback')).toBeVisible();
    await expect(page.getByTestId('pending-interaction-actions')).toBeVisible();
    await page.getByRole('button', { name: 'Allow' }).click();
    await expect(page.getByTestId('run-result').getByText('Ephemeral Agent completed after approval')).toBeVisible();

    await page.getByRole('button', { name: 'Close Run Pane' }).click();
    await expect(page.getByTestId('agent-run-pane')).toHaveCount(0);
    await ephemeralCard.getByRole('button', { name: 'Open →' }).click();
    await expect(page.getByTestId('run-result').getByText('Ephemeral Agent completed after approval')).toBeVisible();

    await page.getByRole('button', { name: 'Continue as Branch' }).click();
    await expect(page.getByText('Branch created: continued-node')).toBeVisible();
    await page.getByRole('button', { name: 'Save as Custom Agent' }).click();
    await expect(page.getByText('Draft saved: Saved Ephemeral Agent')).toBeVisible();
    expect(agents.continuedRunIds).toEqual(['run-ephemeral']);
    expect(agents.savedRunIds).toEqual(['run-ephemeral']);
  });
});
