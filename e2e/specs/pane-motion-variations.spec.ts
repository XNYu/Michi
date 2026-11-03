import { expect, test, type Page } from '@playwright/test';
import { installMockApi } from '../fixtures/mockApi';
import { leaveSettings, openSettings } from '../fixtures/shell';

const variants = [
  // The default drifts the content in from the side the pane arrives on: the
  // third pane opens right of the focused root, so it comes from the right.
  ['soft-fade', 'Soft Fade', 180, 8, 0],
  ['gentle-glide', 'Gentle Glide', 180, 0, 8],
  ['frozen-retract', 'Frozen Retract', 220, 0, -6],
] as const;

async function boot(page: Page, motion: string) {
  await installMockApi(page, { custom: async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent-runs') { await route.fulfill({json:{runs:[]}}); return true; }
    if (path === '/api/agent-runs/subscribe') { await route.fulfill({contentType:'text/event-stream',body:': keepalive\n\n'}); return true; }
    return false;
  } });
  await page.addInitScript(motion => {
    localStorage.clear(); sessionStorage.clear();
    const ids = ['root', 'second', 'third'];
    const paragraph = 'A quiet workspace preserves the reading position and the shape of every paragraph. Closing a branch should retire the conversation as one object, without squeezing words into a narrower column.';
    const nodes = Object.fromEntries(ids.map(id => [id, {
      nodeId:id, kind:'chat', chatId:null, projectId:'motion-ws', title:`${id} conversation`, status:'idle', followUps:[],
      messages:[
        {id:`${id}-q`,role:'user',text:'Compare the pane motion and keep my reading position.',toolCalls:[],createdAt:1},
        {id:`${id}-a`,role:'assistant',text:'',toolCalls:[],createdAt:2,blocks:[{id:`${id}-block`,kind:'answer',rawText:`### Reading without interruption\n\n${paragraph}\n\n\`\`\`typescript\nconst surface = { width: 800, freeze: true };\nconst layout = surface.width;\n\`\`\`\n\n${Array(12).fill(paragraph).join('\n\n')}`} ]},
      ],
    }]));
    localStorage.setItem('michi:migrated','1');
    localStorage.setItem('michi:v1:state',JSON.stringify({version:6,activeProjectId:'motion-ws',nodes,projects:[{
      id:'motion-ws',name:'Pane motion review',chatIds:ids,edges:ids.slice(1).map(target => ({source:'root',target,kind:'branch'})),
      trees:[{id:'tree',rootNodeId:'root',name:'root conversation',createdAt:1,lastActiveAt:1}],activeTreeId:'tree',contexts:[],createdAt:1,
    }]}));
    localStorage.setItem('michi:v1:prefs',JSON.stringify({paneSpawnAnimation:motion,paneWidthMode:'adaptive',defaultPaneWidth:800,singlePaneContentWidth:480}));
    sessionStorage.setItem('michi:panes:open',JSON.stringify({'motion-ws::tree':['root','second']}));
    sessionStorage.setItem('michi:panes:focus',JSON.stringify({'motion-ws::tree':'root'}));
  },motion);
  await page.goto('/');
  await page.getByText('root conversation',{exact:true}).first().click();
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(2);
}

async function settled(page: Page, count: number) {
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(count);
  await expect.poll(() => page.locator('.terminal-dashboard > [data-node-id], .pane-entry-surface, [data-pane-caption-id]')
    .evaluateAll(elements => elements.flatMap(el => el.getAnimations())
      .filter(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame || 'clipPath' in frame || 'opacity' in frame)).length)).toBe(0);
}

test.use({viewport:{width:1480,height:1000}});

for (const [motion,label,duration,entryX,entryY] of variants) {
  test(`${label}: frozen message layout, coordinated reveal and settings`,async ({page},info) => {
    const errors: string[] = [];
    page.on('pageerror',error => errors.push(error.message));
    await boot(page,motion);
    const openFrames = await page.getByRole('complementary').getByText('third conversation',{exact:true}).first().evaluate(async element => {
      const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
      (element as HTMLElement).click();
      await new Promise(requestAnimationFrame);
      const slot = strip.querySelector<HTMLElement>(':scope > [data-node-id="third"]')!;
      const surface = slot.querySelector<HTMLElement>('.pane-entry-surface')!;
      const entrances = surface.getAnimations().map(animation => ({
        duration: animation.effect?.getTiming().duration,
        frames: animation.effect!.getKeyframes().map(frame => {
          const matrix = new DOMMatrixReadOnly(String(frame.transform));
          return { x: matrix.e, y: matrix.f, scale: matrix.a, opacity: Number(frame.opacity), filter: frame.filter ?? null };
        }),
      }));
      const clock = [...strip.querySelectorAll(':scope > [data-node-id]')].flatMap(el => el.getAnimations())
        .find(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame));
      const frames = [];
      for (let i=0;i<32;i++) {
        await new Promise(requestAnimationFrame);
        const rect = slot.getBoundingClientRect();
        const viewport = strip.getBoundingClientRect();
        frames.push({ scroll: strip.scrollLeft, w: rect.width,
          visible: Math.max(0, Math.min(rect.right, viewport.right) - Math.max(rect.left, viewport.left)),
          progress: clock?.effect?.getComputedTiming().progress ?? null,
          x: new DOMMatrixReadOnly(getComputedStyle(surface).transform).e });
      }
      return { entrances, frames };
    });
    expect(openFrames.entrances).toEqual([{ duration, frames: [
      { x: entryX, y: entryY, scale: 1, opacity: 1, filter: null },
      { x: 0, y: 0, scale: 1, opacity: 1, filter: null },
    ] }]);
    const lastOpen = openFrames.frames.at(-1)!;
    expect(openFrames.frames.some(frame => frame.progress !== null && frame.progress > 0 && frame.progress < 1
      && frame.scroll > 20 && frame.visible > 0 && frame.visible < lastOpen.visible - 10)).toBe(true);
    expect(openFrames.frames.every(frame => Math.abs(frame.w - lastOpen.w) < 1)).toBe(true);
    if (motion === 'gentle-glide') expect(openFrames.frames.every(frame => frame.x === 0)).toBe(true);
    await settled(page,3);

    for (const id of ['third','second']) {
      // Focus without scrolling the page or changing the pane's reading offset.
      await page.locator(`[data-pane-caption-id="${id}"]`).click();
      await page.waitForTimeout(300);
      const captured = await page.evaluate(async id => {
        const strip = document.querySelector<HTMLElement>('.terminal-dashboard')!;
        const slot = strip.querySelector<HTMLElement>(`:scope > [data-node-id="${id}"]`)!;
        const surface = slot.querySelector<HTMLElement>('.pane-entry-surface')!;
        const caption = document.querySelector<HTMLElement>(`[data-pane-caption-id="${id}"]`)!;
        const paragraph = slot.querySelector<HTMLElement>('.prose p')!;
        const code = slot.querySelector<HTMLElement>('pre')!;
        const scroller = slot.querySelector<HTMLElement>('.term-scrollbar')!;
        scroller.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true}));
        scroller.scrollTop = 100;
        await new Promise(requestAnimationFrame);
        const measure = () => ({width:surface.getBoundingClientRect().width,height:surface.getBoundingClientRect().height,
          paragraphWidth:paragraph.getBoundingClientRect().width,paragraphHeight:paragraph.getBoundingClientRect().height,
          codeWidth:code.getBoundingClientRect().width,scroll:scroller.scrollTop,captionWidth:caption.getBoundingClientRect().width});
        const before = measure();
        (document.activeElement as HTMLElement)?.blur();
        window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true,cancelable:true}));
        await new Promise(requestAnimationFrame);
        const clocks = [...document.querySelectorAll('.terminal-dashboard > [data-node-id], [data-pane-caption-id]')]
          .flatMap(el => el.getAnimations()).filter(animation => animation.effect?.getKeyframes().some(frame => 'transform' in frame));
        const exit = slot.getAnimations().find(animation => animation.effect?.getKeyframes().some(frame => 'clipPath' in frame || 'opacity' in frame));
        const duration = Number(exit?.effect?.getTiming().duration ?? 0);
        const exitFrames = exit?.effect?.getKeyframes() ?? [];
        for (const animation of clocks) { animation.pause(); animation.currentTime = 0; }
        const frames = [];
        // Seek the real exit clock: each sample remains mounted until we finish it.
        for (const progress of [0, .25, .5, .75, .99]) {
          for (const animation of clocks) animation.currentTime = duration * progress;
          await new Promise(requestAnimationFrame);
          if (!slot.isConnected) continue;
          const style = getComputedStyle(slot);
          const clip = style.clipPath.match(/-?[\d.]+px/g)?.map(parseFloat) ?? [0, 0, 0, 0];
          frames.push({...measure(),slot:slot.getBoundingClientRect().width,opacity:Number(style.opacity),inert:slot.inert,
            visible: slot.getBoundingClientRect().width - (clip[1] ?? 0) - (clip[3] ?? 0),
            body:getComputedStyle(strip).gridTemplateColumns.split(' ').map(parseFloat),
            captions:getComputedStyle(document.querySelector('[data-pane-captions]')!).gridTemplateColumns.split(' ').map(parseFloat),
            error: Math.max(...[...strip.querySelectorAll<HTMLElement>(':scope > [data-node-id]')].map(pane =>
              Math.abs(pane.getBoundingClientRect().left - document.querySelector(`[data-pane-caption-id="${pane.dataset.nodeId}"]`)!.getBoundingClientRect().left))),
          });
        }
        for (const animation of clocks) animation.finish();
        return {before,frames,duration,exitFrames};
      },id);
      await info.attach(`${id}-exit-frames`,{body:JSON.stringify(captured,null,2),contentType:'application/json'});
      expect(captured.frames.length).toBeGreaterThan(3);
      for (const frame of captured.frames) {
        expect(frame.width).toBeCloseTo(captured.before.width,1);
        expect(frame.height).toBeCloseTo(captured.before.height,1);
        expect(frame.paragraphWidth).toBeCloseTo(captured.before.paragraphWidth,1);
        expect(frame.paragraphHeight).toBeCloseTo(captured.before.paragraphHeight,1);
        expect(frame.codeWidth).toBeCloseTo(captured.before.codeWidth,1);
        expect(frame.scroll).toBeCloseTo(captured.before.scroll,0);
        expect(frame.captionWidth).toBeCloseTo(captured.before.captionWidth,1);
        expect(frame.inert).toBe(true);
        expect(frame.error).toBeLessThan(2);
        expect(frame.body.length).toBe(frame.captions.length);
        expect(frame.body.every((width,i) => Math.abs(width-frame.captions[i])<2)).toBe(true);
      }
      expect(captured.duration).toBe(id === 'third' ? 160 : 110);
      expect(captured.frames.every(frame => Math.abs(frame.slot - captured.before.width) < 1)).toBe(true);
      // All entry variants share fixed-width cover exits, then a staged 2→1 fade.
      if (id === 'third') {
        expect(captured.exitFrames.some(frame => frame.clipPath !== undefined)).toBe(true);
        expect(captured.frames.some(frame => frame.visible > 0 && frame.visible < captured.before.width - 20 && frame.opacity === 1)).toBe(true);
      } else {
        expect(captured.exitFrames.map(frame => Number(frame.opacity))).toEqual([1, 0]);
        expect(captured.frames.some(frame => frame.opacity < .8 && frame.opacity > 0)).toBe(true);
      }
      await settled(page,id === 'third' ? 2 : 1);
    }

    const settings = await openSettings(page, 'Appearance');
    await settings.getByRole('button', { name: /Advanced/i }).click();
    const select = page.getByRole('combobox',{name:'Pane animation',exact:true});
    await expect(select).toHaveValue(motion);
    await select.selectOption(motion);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('michi:v1:prefs')!).paneSpawnAnimation)).toBe(motion);
    await expect.poll(async () => {
      const box = (await settings.boundingBox())!;
      return box.x + box.width;
    }).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    await page.screenshot({path:info.outputPath(`${motion}-settings.png`)});
    await leaveSettings(page);
    await page.getByRole('complementary').getByText('second conversation',{exact:true}).first().click();
    await settled(page,2);
    await page.screenshot({path:info.outputPath(`${motion}-panes.png`)});
    expect(errors).toEqual([]);
  });
}

test('quiet exits support reopen, last pane, reduced motion and narrow windows',async ({page}) => {
  await boot(page,'soft-fade');
  await page.locator('[data-pane-caption-id="second"]').click();
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true,cancelable:true})));
  await page.getByRole('complementary').getByText('second conversation',{exact:true}).first().click();
  await settled(page,2);
  await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(page.locator('.terminal-dashboard > [data-node-id]')).toHaveCount(2);
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true,cancelable:true})));
  await settled(page,1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.locator('[data-pane-exiting]')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true,bubbles:true,cancelable:true})));
  await expect(page.locator('.terminal-dashboard')).toHaveCount(0);
});
