import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

for (const view of ['activity', 'structure'] as const) {
  test(`${view}: content width stays fixed throughout sidebar toggles`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installMockApi(page);
    await page.addInitScript(sidebarView => {
      localStorage.setItem('michi:v1:prefs', JSON.stringify({
        sidebarView, sidebarCollapsed: false, terminalSidebarWidth: 320, onboardingCompletedAt: 1,
      }));
    }, view);
    await bootWithWorkspace(page, 'Sidebar animation');
    await page.locator('[contenteditable="true"]').first().fill('Check sidebar animation');
    await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
    await expect(page.locator('.terminal-dashboard')).toBeVisible();
    const inner = page.locator('.terminal-sidebar-content');
    await expect(inner).toBeVisible();
    const original = await inner.elementHandle();

    for (const label of ['Collapse sidebar', 'Open sidebar', 'Collapse sidebar', 'Open sidebar']) {
      const frames = await page.evaluate(async label => {
        const shell = document.querySelector<HTMLElement>('.terminal-sidebar')!;
        const content = document.querySelector<HTMLElement>('.terminal-sidebar-content')!;
        const samples: Array<{ shell: number; content: number }> = [];
        (document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click();
        const started = performance.now();
        while (performance.now() - started < 350) {
          await new Promise(requestAnimationFrame);
          samples.push({ shell: shell.getBoundingClientRect().width, content: content.getBoundingClientRect().width });
        }
        return samples;
      }, label);
      expect(frames.every(frame => Math.abs(frame.content - 320) < 1)).toBe(true);
      expect(frames.at(-1)!.shell).toBeCloseTo(label === 'Collapse sidebar' ? 0 : 320, 0);
      expect(await inner.evaluate((element, old) => element === old, original)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath(`${view}-desktop.png`) });

    await page.setViewportSize({ width: 600, height: 850 });
    await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
    await expect(inner).toBeVisible();
    expect((await inner.boundingBox())!.width).toBeCloseTo(320, 0);
    await expect.poll(async () => (await inner.boundingBox())!.x).toBe(0);
    await expect(page.locator('.terminal-sidebar').getByText('Settings', { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${view}-narrow.png`) });
    await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
    await expect(inner).toHaveCount(0);
  });
}
