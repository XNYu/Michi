import { expect, test } from '@playwright/test';
import { bootWithWorkspace } from '../fixtures/mockApi';
import { installComposerModels } from '../fixtures/composerModels';
import { leaveSettings, openSettings } from '../fixtures/shell';

test('scopes Workflows to the selected runtime and hides unavailable runtimes in Settings and composer', async ({ page }) => {
  const { status } = await installComposerModels(page);
  Object.assign(status, { runtime: 'kiro', label: 'Kiro', workflowRuntimes: ['kiro'], workflowsByRuntime: { kiro: true } });
  status.availableRuntimes = status.availableRuntimes.map((runtime) => runtime.id === 'kiro' ? { ...runtime, available: true } : runtime);
  status.availableRuntimes.push({ id: 'crew', label: 'Kiro Crew', available: false });
  await bootWithWorkspace(page, 'Runtime visibility');
  await openSettings(page, 'Runtime (global)');
  await expect(page.getByRole('switch', { name: 'Workflows for Kiro' })).toHaveAttribute('aria-checked', 'true');
  const runtime = page.getByRole('combobox', { name: 'Runtime', exact: true });
  await expect(runtime.locator('option[value="crew"]')).toHaveCount(0);
  await runtime.selectOption('claude');
  await expect(page.getByRole('switch', { name: /Workflows/ })).toHaveCount(0);
  await leaveSettings(page);
  await page.getByRole('button', { name: /^Model settings:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Model settings' });
  await picker.getByRole('button', { name: /Select runtime:/ }).click();
  await expect(picker.getByRole('menuitemradio', { name: 'Claude', exact: true })).toBeVisible();
  await expect(picker.getByRole('menuitemradio', { name: /Kiro Crew/ })).toHaveCount(0);
});
