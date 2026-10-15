import { test, expect } from '@playwright/test';
import { CREW_DESCRIPTOR } from '../../backend/src/agents/capabilityDescriptors';
import { installMockApi, bootWithWorkspace } from '../fixtures/mockApi';

test('Crew renders native tool/title metadata and offers fork with common approvals and memory controls', async ({ page }) => {
  let defaultMemory = 'incognito';
  await installMockApi(page, {
    custom: async (route) => {
      const path = new URL(route.request().url()).pathname.replace(/^.*\/api/, '');
      if (path === '/crew/status') {
        await route.fulfill({ json: { approvals: true, mcpDeclared: true, mcpRouted: true } }); return true;
      }
      if (path === '/crew/memory') {
        if (route.request().method() === 'POST') defaultMemory = route.request().postDataJSON().defaultMode;
        await route.fulfill({ json: { defaultMode: defaultMemory, mode: 'incognito' } });
        return true;
      }
      if (path !== '/agent/status') return false;
      await route.fulfill({ json: {
        runtime: 'crew', label: 'Kiro Crew', hasRequiredKey: true,
        nativeResumeByRuntime: {}, nativeForkByRuntime: {},
        capabilities: { modes: true, permissions: true, models: true, providerModels: false,
          reasoning: true, apiKeys: false, warmSessions: false, saveContext: true,
          spawnBranches: true, nativeResume: true },
        capabilityDescriptor: CREW_DESCRIPTOR,
        availableRuntimes: [{ id: 'crew', label: 'Kiro Crew', available: true }],
      } });
      return true;
    },
    streamEvents: [
      { event: 'tool_call', data: { toolCallId: 'crew-row-1', title: 'Read probe.txt', status: 'in_progress', kind: 'read' } },
      { event: 'tool_call_update', data: { toolCallId: 'crew-row-1', title: 'Read probe.txt', status: 'completed', kind: 'read', output: 'CREW_FILE_CONTENTS' } },
      { event: 'context_usage', data: { contextUsagePercentage: 24.5 } },
      { event: 'chunk', data: { text: 'Crew read the requested file.' } },
      { event: 'title', data: { title: 'Crew file check' } },
      { event: 'done', data: { stopReason: 'end_turn' } },
    ],
  });
  await bootWithWorkspace(page, 'Crew validation');
  await expect(page.getByRole('button', { name: /^Permissions:/ }).first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Crew memory' })).toHaveCount(0);
  await page.locator('[contenteditable="true"]').first().fill('Read probe.txt');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Crew read the requested file.')).toBeVisible();
  await expect(page.getByText('Crew file check').first()).toBeVisible();
  await expect(page.getByText('Read probe.txt', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Permissions:/ }).first()).toBeVisible();
  await page.getByText('Settings', { exact: true }).last().click();
  await page.getByText('Model', { exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Native Resume for Kiro Crew' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Native Fork for Kiro Crew' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('switch', { name: 'Use global permissions' })).toBeVisible();
  const memory = page.getByRole('combobox', { name: 'Crew memory' });
  await expect(memory).toHaveValue('incognito');
  await memory.selectOption('persistent');
  await expect.poll(() => defaultMemory).toBe('persistent');
  await expect(memory).toHaveValue('persistent');
});
