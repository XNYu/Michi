import { expect, test } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';

for (const kiroAvailable of [false, true]) {
  test(`first launch requires an explicit choice with Kiro ${kiroAvailable ? 'installed' : 'absent'}`, async ({ page }) => {
    let selected = '';
    let completed: number | null = null;
    const selections: string[] = [];
    await installMockApi(page, {
      custom: async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname.replace(/^.*\/api/, '');
        const json = async (body: unknown) => {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
          return true;
        };
        if (path === '/prefs' && request.method() === 'GET') return json({ prefs: { onboardingCompletedAt: completed } });
        if (path === '/prefs' && request.method() === 'PUT') {
          completed = request.postDataJSON().prefs?.onboardingCompletedAt ?? request.postDataJSON().onboardingCompletedAt ?? completed;
          return json({ ok: true });
        }
        if (path === '/agent/status') return json({
          runtime: selected, label: selected || 'Choose a runtime', hasRequiredKey: true,
          capabilities: { modes: false, models: false, permissions: false, providerModels: false, reasoning: false,
            supportedReasoningLevels: [], apiKeys: false, warmSessions: false, saveContext: false, spawnBranches: false, nativeResume: false },
          availableRuntimes: [
            { id: 'kiro', label: 'Kiro', available: kiroAvailable },
            { id: 'pi', label: 'Pi', available: true, requiresApiKey: true },
            { id: 'codex', label: 'Codex', available: true },
            { id: 'claude', label: 'Claude', available: true },
          ],
        });
        if (path === '/agent/options') {
          selected = request.postDataJSON().runtime;
          selections.push(selected);
          return json({ ok: true });
        }
        return false;
      },
    });
    await page.goto('/');
    const setup = page.getByRole('dialog', { name: 'Setup', exact: true });
    await expect(setup).toBeVisible();
    await expect(setup.getByRole('button', { pressed: true })).toHaveCount(0);
    await expect(setup.getByText('recommended', { exact: true })).toHaveCount(0);
    await expect(setup.getByRole('button', { name: 'Choose a runtime' })).toBeDisabled();
    await expect(setup.getByRole('button', { name: /^Kiro/ })).toHaveCount(kiroAvailable ? 1 : 0);
    expect(selections).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(setup).toBeVisible();
    await setup.getByRole('button', { name: /^Codex/ }).click();
    await setup.getByRole('button', { name: 'Start with Codex →' }).click();
    await expect(setup).toHaveCount(0);
    expect(selections).toEqual(['codex']);
    await expect.poll(() => completed).not.toBeNull();
    await page.reload();
    await expect(page.getByRole('dialog', { name: 'Setup', exact: true })).toHaveCount(0);
    expect(selected).toBe('codex');
  });
}
