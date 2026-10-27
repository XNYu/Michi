import { expect, test, type Locator, type Page } from '@playwright/test';
import { installMockApi, sseBody } from '../fixtures/mockApi';

const sample = [
  '#### **背景**',
  '**把复杂的工作，拆成清楚的下一步**',
  '好的正文排版让你能顺着读下去。A comfortable reading rhythm keeps English and 中文 naturally together, without making every line feel crowded.',
  '先确定目标，再补充细节。段落之间留一点呼吸，列表内部保持紧凑。检查 `app.ts` 的入口。',
  '- 第一项：保留上下文，知道这件事为什么要做。\n- Second item: make the next action easy to understand.\n  - 子项：层级清楚，也不挤占太多宽度。',
  '列表结束后，留出一个更明显的间隔，再开始下一组说明。',
  '#### **具体要做的事**',
  '按照步骤阅读，让中英文、标题和多层列表都有稳定的节奏。',
  '1. **阅读接入文档** — 先确认上下文。\n\n   - 添加依赖\n   - 修改入口并验证\n\n2. **回复工单** — 给出预计完成日期。',
  '#### **后果（如果不做）**',
  '列表结束后接标题，需要保留分组感。',
  '- 表格前的列表',
  '| 项目 | 状态 |\n| --- | --- |\n| 正文 | 完成 |',
  '表格结束后的段落。',
  '```ts\nconst ready = true;\n```',
  '代码块结束后的段落。',
  '# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n##### 五级标题\n\n###### 六级标题',
].join('\n\n');

declare global {
  interface Window { typographyStream?: ReadableStreamDefaultController<Uint8Array> }
}

async function bootTypography(page: Page, prefs: Record<string, unknown>, twoPanes = false) {
  await installMockApi(page);
  await page.addInitScript(({ sample, prefs, twoPanes }) => {
    localStorage.setItem('michi:migrated', '1');
    localStorage.setItem('michi:ff:streamingMarkdownBlocks', 'true');
    localStorage.setItem('michi:v1:state', JSON.stringify({
      version: 6, activeProjectId: 'type-ws',
      nodes: Object.fromEntries(['root', 'branch'].map(nodeId => [nodeId, {
        nodeId, kind: 'chat', chatId: null, projectId: 'type-ws', title: 'Reading rhythm',
        status: 'idle', followUps: [], messages: [
          { id: `${nodeId}-user`, role: 'user', text: '帮我把接下来的工作讲清楚。', toolCalls: [], createdAt: 1 },
          { id: `${nodeId}-answer`, role: 'assistant', text: sample, toolCalls: [], createdAt: 2 },
        ],
      }])),
      projects: [{ id: 'type-ws', name: 'Typography', chatIds: ['root', 'branch'],
        edges: [{ source: 'root', target: 'branch', kind: 'branch' }],
        trees: [{ id: 'tree', rootNodeId: 'root', createdAt: 1, lastActiveAt: 1 }],
        activeTreeId: 'tree', artifacts: [], createdAt: 1 }],
    }));
    localStorage.setItem('michi:v1:prefs', JSON.stringify({
      onboardingCompletedAt: 1, sidebarCollapsed: true, reduceMotion: true, ...prefs,
    }));
    sessionStorage.setItem('michi:panes:open', JSON.stringify({ 'type-ws::tree': twoPanes ? ['root', 'branch'] : ['root'] }));
    sessionStorage.setItem('michi:panes:focus', JSON.stringify({ 'type-ws::tree': null }));
  }, { sample, prefs, twoPanes });
  await page.goto('/');
  await page.getByRole('button', { name: /Reading rhythm Typography/ }).click();
  await expect(page.locator('.terminal-message-assistant').first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

async function rhythm(message: Locator) {
  return message.evaluate(element => {
    const paragraphs = Array.from(element.querySelectorAll('.prose p')).filter(p => !p.closest('li'));
    const list = element.querySelector('.prose ul')!;
    const box = (el: Element) => el.getBoundingClientRect();
    return {
      size: getComputedStyle(paragraphs[0]).fontSize,
      leading: getComputedStyle(paragraphs[0]).lineHeight,
      paragraphGap: box(paragraphs[2]).top - box(paragraphs[1]).bottom,
      beforeList: box(list).top - box(paragraphs[2]).bottom,
      afterList: box(paragraphs[3]).top - box(list).bottom,
      listIndent: getComputedStyle(list).paddingInlineStart,
      itemIndent: getComputedStyle(list.children[0]).paddingInlineStart,
      itemMargins: Array.from(list.querySelectorAll('li')).map(li => getComputedStyle(li).marginBottom),
      width: box(paragraphs[0]).width,
      h4Size: getComputedStyle(element.querySelector('h4')!).fontSize,
      h4Leading: getComputedStyle(element.querySelector('h4')!).lineHeight,
      headingWeight: getComputedStyle(element.querySelector('h4 strong')!).fontWeight,
      afterHeading: box(paragraphs[0]).top - box(element.querySelector('h4')!).bottom,
      itemGap: box(list.children[1]).top - box(list.children[0]).bottom,
      nestedGap: getComputedStyle(list.querySelector('ul')!).marginTop,
      markers: getComputedStyle(list.querySelector('ul')!).listStyleType,
      beforeH4: box(element.querySelectorAll('h4')[1]).top - box(paragraphs[3]).bottom,
      listToHeading: box(element.querySelectorAll('h4')[2]).top - box(element.querySelector('.prose ol')!).bottom,
      inlineCodeWeight: getComputedStyle(element.querySelector('p code')!).fontWeight,
      beforeTable: box(element.querySelector('.michi-table-feature')!).top - box(element.querySelectorAll('.prose > ul')[1]).bottom,
      afterCode: box(Array.from(element.querySelectorAll('p')).find(p => p.textContent === '代码块结束后的段落。')!).top - box(element.querySelector('.michi-code-block')!).bottom,
      afterTable: box(Array.from(element.querySelectorAll('p')).find(p => p.textContent === '表格结束后的段落。')!).top - box(element.querySelector('.michi-table-feature')!).bottom,
      headingSizes: Array.from(element.querySelectorAll('h1,h2,h3,h5,h6')).map(h => getComputedStyle(h).fontSize),
    };
  });
}

for (const [density, palette, twoPanes] of [
  ['compact', 'bone', false], ['dense', 'monokai', false], ['comfortable', 'bone', true],
] as const) {
  test(`${density}: Code prose rhythm in ${twoPanes ? 'two panes' : 'one pane'}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await bootTypography(page, { terminalDensity: density, terminalPalette: palette }, twoPanes);
    const message = page.locator('.terminal-message-assistant').first();
    const measured = await rhythm(message);
    expect(measured.size).toBe('16px');
    expect(measured.leading).toBe('24px');
    expect(measured.paragraphGap).toBeCloseTo(12, 1);
    expect(measured.beforeList).toBeCloseTo(12, 1);
    expect(measured.afterList).toBeCloseTo(24, 1);
    expect(measured.listIndent).toBe('32px');
    expect(measured.itemIndent).toBe('8px');
    expect(measured.itemMargins.every(margin => margin === '0px')).toBe(true);
    expect(measured.inlineCodeWeight).toBe('400');
    expect(measured.afterTable).toBeCloseTo(24, 1);
    expect(measured.beforeTable).toBeCloseTo(24, 1);
    expect(measured.afterCode).toBeCloseTo(12, 1);
    expect(measured.h4Size).toBe('16px');
    expect(parseFloat(measured.h4Leading)).toBeCloseTo(20.8, 1);
    expect(measured.headingWeight).toBe('580');
    expect(measured.afterHeading).toBeCloseTo(8, 1);
    expect(measured.itemGap).toBeCloseTo(4, 1);
    expect(parseFloat(measured.nestedGap)).toBeCloseTo(4, 1);
    expect(measured.markers).toBe('circle');
    expect(measured.beforeH4).toBeCloseTo(20, 1);
    expect(measured.listToHeading).toBeCloseTo(24, 1);
    expect(measured.headingSizes).toEqual(['28px', '22px', '18px', '14px', '14px']);
    if (!twoPanes) expect(measured.width).toBeCloseTo(676, 0);
    await expect(page.locator('.terminal-message-user .prose').first()).toHaveCSS('line-height', '24px');
    await page.screenshot({ path: info.outputPath(`${density}-${palette}.png`) });
    if (twoPanes) {
      await expect(page.locator('.terminal-message-assistant')).toHaveCount(2);
      await page.setViewportSize({ width: 900, height: 900 });
      expect((await rhythm(message)).leading).toBe('24px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('two-panes-narrow.png') });
    }
  });
}

test('preserves saved font size and reading width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await bootTypography(page, { messageFontSize: 18, singlePaneContentWidth: 1060 });
  const measured = await rhythm(page.locator('.terminal-message-assistant').first());
  expect(measured.size).toBe('18px');
  expect(parseFloat(measured.leading)).toBeCloseTo(27, 1);
  expect(measured.width).toBeCloseTo(1060, 0);
  expect(measured.paragraphGap).toBeCloseTo(13.5, 1);
});

test('streamed blocks keep the same gaps when the answer settles', async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
      if (/\/chats\/[^/]+\/message$/.test(url.pathname) && init?.method === 'POST') {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { window.typographyStream = controller; },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  });
  await bootTypography(page, { terminalDensity: 'compact', terminalPalette: 'bone' });
  await page.locator('[contenteditable="true"]').first().fill('请展示排版');
  await page.getByRole('button', { name: 'Send (Enter)', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!window.typographyStream)).toBe(true);
  for (const text of [sample.slice(0, 60), sample.slice(60)]) {
    await page.evaluate(body => window.typographyStream!.enqueue(new TextEncoder().encode(body)),
      sseBody([{ event: 'chunk', data: { text } }]));
  }
  const answer = page.locator('.terminal-message-assistant').last();
  await expect(answer.getByText('列表结束后，留出一个更明显的间隔，再开始下一组说明。', { exact: true })).toBeVisible();
  // A live response really uses separate display:contents Markdown roots.
  await expect.poll(() => answer.locator('.prose.contents').count()).toBeGreaterThan(1);
  await expect(answer.getByRole('heading', { level: 6, name: '六级标题' })).toBeVisible();
  const live = await rhythm(answer);
  await page.screenshot({ path: info.outputPath('streaming.png') });
  await page.evaluate(body => {
    window.typographyStream!.enqueue(new TextEncoder().encode(body));
    window.typographyStream!.close();
  }, sseBody([{ event: 'done', data: { stopReason: 'end_turn' } }]));
  await expect(answer.locator('.prose.contents')).toHaveCount(0);
  const settled = await rhythm(answer);
  expect(live).toEqual(settled);
  expect(settled.paragraphGap).toBeCloseTo(12, 1);
  expect(settled.afterList).toBeCloseTo(24, 1);
  await page.screenshot({ path: info.outputPath('settled.png') });
});
