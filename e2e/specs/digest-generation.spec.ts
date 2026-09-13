import { expect, test } from '@playwright/test';
import { bootWithWorkspace, installMockApi } from '../fixtures/mockApi';

declare global {
  interface Window {
    digestTestStream?: ReadableStreamDefaultController<Uint8Array>;
    digestTestRequests: Array<{ customPrompt?: string; previousContent?: string }>;
  }
}

test('digest streams temporary thoughts, clears them on completion, and uses edited prompts on rebuild', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await installMockApi(page);
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.digestTestRequests = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/digests/stream')) {
        window.digestTestRequests.push(JSON.parse(String(init?.body)));
        return new Response(new ReadableStream<Uint8Array>({ start(controller) { window.digestTestStream = controller; } }), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return originalFetch(input, init);
    };
  });
  await bootWithWorkspace(page, 'Digest regression');
  await page.locator('[contenteditable="true"]').first().fill('Summarize our decisions');
  await page.getByRole('button', { name: /Send \(Enter\)/ }).click();
  await expect(page.getByText('Hello from mock kiro.')).toBeVisible();
  await page.getByRole('button', { name: 'Digest', exact: true }).click();
  await page.getByRole('textbox', { name: 'Digest guidance (optional)' }).fill('Focus on decisions');
  await page.getByRole('button', { name: 'Create digest', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Digest generation', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.digestTestRequests.length)).toBe(1);
  await page.evaluate(() => {
    window.digestTestStream!.enqueue(new TextEncoder().encode(
      'event: thought\ndata: {"text":"Comparing conclusions across source conversations.\\nChecking decisions and unresolved questions."}\n\n'
      + 'event: chunk\ndata: {"text":"# Research digest\\n\\nThe investigation connects the source conversations."}\n\n',
    ));
  });
  await expect(page.getByRole('region', { name: 'Digest thinking' })).toContainText('Comparing conclusions');
  const toggle = page.getByRole('button', { name: 'CUSTOM PROMPT' });
  expect(await toggle.evaluate(el => getComputedStyle(el.parentElement!).getPropertyValue('-webkit-app-region'))).toBe('no-drag');
  await toggle.click();
  const prompt = page.getByRole('textbox', { name: 'Custom digest prompt' });
  await prompt.fill('Focus on risks and next steps');
  await expect(prompt).toHaveValue('Focus on risks and next steps');
  await expect(page.getByRole('button', { name: /Rebuild/ })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('digest-thinking-desktop.png') });

  await page.setViewportSize({ width: 900, height: 900 });
  const thought = page.getByRole('region', { name: 'Digest thinking' });
  expect(await thought.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('digest-thinking-narrow.png') });

  await page.evaluate(() => {
    window.digestTestStream!.enqueue(new TextEncoder().encode('event: done\ndata: {"markdown":"# Research digest\\n\\nThe investigation connects the source conversations.\\n\\n## Conclusions\\n\\nThe final conclusions are ready."}\n\n'));
    window.digestTestStream!.close();
  });
  await expect(page.getByRole('region', { name: 'Digest generation', exact: true })).toHaveCount(0);
  await expect(page.getByText('The final conclusions are ready.')).toBeVisible();
  await expect(prompt).toHaveValue('Focus on risks and next steps');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: info.outputPath('digest-complete.png') });

  await page.getByRole('button', { name: /Rebuild/ }).click();
  await expect.poll(() => page.evaluate(() => window.digestTestRequests.length)).toBe(2);
  expect(await page.evaluate(() => window.digestTestRequests[1])).toMatchObject({
    customPrompt: 'Focus on risks and next steps', previousContent: expect.stringContaining('The final conclusions are ready.'),
  });
  await expect(page.getByRole('region', { name: 'Digest thinking' })).toHaveCount(0);
  await page.evaluate(() => {
    window.digestTestStream!.enqueue(new TextEncoder().encode('event: error\ndata: {"message":"Mock generation failed"}\n\n'));
    window.digestTestStream!.close();
  });
  await expect(page.getByRole('alert')).toHaveText('Mock generation failed');
  await expect(page.getByRole('button', { name: /Rebuild/ })).toBeEnabled();
  expect(errors).toEqual([]);
});
