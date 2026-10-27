import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

for (const palette of ['bone', 'monokai']) {
  for (const vibrancy of [false, true]) {
    test(`${palette}, ${vibrancy ? 'native tint' : 'opaque'}: window controls share an unbroken frame with the sidebar`, async ({ page }, info) => {
      await page.setViewportSize({ width: 1280, height: 820 });
      await installMockApi(page);
      await page.addInitScript(({ palette, vibrancy }) => {
        localStorage.setItem('michi:v1:prefs', JSON.stringify({
          onboardingCompletedAt: 1, terminalPalette: palette, sidebarCollapsed: true,
        }));
        if (vibrancy) document.addEventListener('DOMContentLoaded', () => {
          document.documentElement.setAttribute('data-vibrancy', 'on');
        });
      }, { palette, vibrancy });
      await bootWithWorkspace(page, 'Window frame');
      await page.getByRole('textbox', { name: 'Message' }).fill('Keep the window controls together.');
      await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
      await expect(page.locator('.terminal-dashboard')).toBeVisible();

      const sidebar = page.locator('.terminal-sidebar');
      const content = page.locator('.terminal-content-col');
      const spacer = page.locator('.terminal-topbar-sidebar-spacer');
      for (const collapsed of [true, false, true]) {
        await expect(sidebar).toHaveCSS('width', collapsed ? '56px' : '280px');
        // The old 56px spacer put its edge between the yellow and green native
        // buttons (the macOS cluster extends to x=66). It must only take space.
        await expect(spacer).toHaveCSS('border-right-width', '0px');
        await expect(spacer).toHaveCSS('box-shadow', 'none');
        await expect(spacer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(page.locator('.terminal-topbar-main')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(page.locator('[data-pane-caption-id]').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        // One tint layer on each leg of the frame, including the rail. A second
        // translucent coat would produce a visible horizontal seam on macOS.
        expect(await page.locator('.terminal-topbar').evaluate(el => getComputedStyle(el).backgroundColor))
          .toBe(await page.locator('.terminal-body').evaluate(el => getComputedStyle(el).backgroundColor));
        await expect(sidebar).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(page.locator('.terminal-sidebar-rail')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        const bodyBounds = (await content.boundingBox())!;
        const barBounds = (await page.locator('.terminal-topbar').boundingBox())!;
        expect(bodyBounds.y).toBe(barBounds.y + barBounds.height);
        expect(bodyBounds.x).toBe(collapsed ? 56 : 280);
        expect(await content.evaluate(el => parseFloat(getComputedStyle(el).borderTopLeftRadius))).toBeGreaterThan(0);
        expect((await page.locator('[data-pane-caption-id]').first().boundingBox())!.x).toBe(bodyBounds.x);
        await page.mouse.move(1000, 600);
        await page.screenshot({ path: info.outputPath(`${palette}-${vibrancy}-${collapsed ? 'collapsed' : 'expanded'}.png`) });
        await page.getByRole('button', { name: collapsed ? 'Open sidebar' : 'Collapse sidebar', exact: true }).click();
      }

      // Docked content clipping/radius must not leak into the narrow overlay.
      await page.setViewportSize({ width: 600, height: 820 });
      await expect(page.locator('.terminal-shell')).toHaveAttribute('data-sidebar-layout', 'overlay');
      await expect(content).toHaveCSS('border-top-left-radius', '0px');
      await expect(content).toHaveCSS('overflow', 'visible');
      await page.getByRole('button', { name: 'Open sidebar', exact: true }).click();
      await expect(sidebar).toBeVisible();
      await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
    });
  }
}
