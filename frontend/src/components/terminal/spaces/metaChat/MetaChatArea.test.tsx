import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { METACHAT_STORAGE_KEY } from '../../../../state/metaChat/metaChatWindowModel';
import { useMetaChatWindow, type UseMetaChatWindowOptions } from '../../../../state/metaChat/useMetaChatWindow';
import { MetaChatArea, useMetaChatDocked, type MetaChatAreaProps } from './MetaChatArea';
import { PageLinkChip } from './PageLinkChip';

vi.mock('../../../MentionEditor', () => import('../../../../test/mentionEditorStub'));
const openSpacesPage = vi.hoisted(() => vi.fn());
vi.mock('../../../../state/metaChat/spacesPages', () => ({ openSpacesPage }));
const firstRun = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('../../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: firstRun.data, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
}));

// The area sits at (100, 50) and measures 1000×800.
const AREA = { left: 100, top: 50, width: 1000, height: 800 };
/** Where a page's text column (`.area-settings__doc`) sits on screen, when a test renders one. */
const column = vi.hoisted(() => ({ rect: { left: 0, top: 0, width: 0, height: 0 } }));

beforeAll(() => {
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {}
    (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent = PointerEventPolyfill;
  }
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const r = this.classList.contains('meta-chat-area') ? AREA
      : this.classList.contains('area-settings__doc') ? column.rect : { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => r } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  firstRun.data = null;
});

type HostProps = Partial<Omit<MetaChatAreaProps, 'controller' | 'children'>> & { options?: UseMetaChatWindowOptions };

function Page() {
  return <div data-testid="page" data-narrow={useMetaChatDocked() ? '' : undefined}>page</div>;
}

function Host({ options = { storage: null }, ...props }: HostProps) {
  const chat = useMetaChatWindow(options);
  return (
    <MetaChatArea controller={chat} pageName="rabbitholes" {...props}>
      <Page />
    </MetaChatArea>
  );
}

const area = () => document.querySelector('.meta-chat-area') as HTMLElement;
const panel = () => screen.getByLabelText('Assistant', { selector: 'section' });
const title = () => panel().querySelector('header') as HTMLElement;
const pageEl = () => document.querySelector('.meta-chat-area__page') as HTMLElement;
const viewing = () => panel().querySelector('.meta-chat-panel__viewing')?.textContent;
const box = () => ({ left: panel().style.left, top: panel().style.top, width: panel().style.width, height: panel().style.height });
const drag = (from: Element, start: [number, number], ...moves: [number, number][]) => {
  fireEvent.pointerDown(from, { button: 0, clientX: start[0], clientY: start[1] });
  for (const [x, y] of moves) fireEvent.pointerMove(window, { clientX: x, clientY: y });
};
const release = () => fireEvent.pointerUp(window);

/** Runs `run` in a phone-sized window where touch is the main input. */
async function onTouchPhone(run: () => void | Promise<void>) {
  const width = window.innerWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 480 });
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: query === '(hover: none) and (pointer: coarse)', media: query }) as MediaQueryList);
  try {
    await run();
  } finally {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  }
}

describe('MetaChatArea', () => {
  it('floats bottom-right at 384×520 with the title bar labels', () => {
    render(<Host />);
    expect(area().dataset.form).toBe('float');
    expect(box()).toEqual({ left: '598px', top: '262px', width: '384px', height: '520px' });
    expect(screen.getByText('Assistant')).toBeTruthy();
    expect(screen.queryByText(/meta agent ·/i)).toBeNull();
    expect(viewing()).toBe('Viewing: rabbitholes');
  });

  it('expands without remounting the conversation, page or draft and restores the floating box', async () => {
    render(<Host conversationKey="first" conversation={<div data-testid="conversation">Previous answer</div>} />);
    const previousPage = pageEl();
    const previousConversation = screen.getByTestId('conversation');
    const previousBox = box();
    const input = await screen.findByRole('textbox', { name: 'Message the assistant' });
    fireEvent.change(input, { target: { value: 'Unsent question' } });
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(area().dataset.form).toBe('full');
    expect(pageEl().hidden).toBe(true);
    expect(pageEl()).toBe(previousPage);
    expect(screen.getByTestId('conversation')).toBe(previousConversation);
    expect((screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement).value).toBe('Unsent question');
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(pageEl().hidden).toBe(false);
    expect(box()).toEqual(previousBox);
    expect((screen.getByRole('textbox', { name: 'Message the assistant' }) as HTMLTextAreaElement).value).toBe('Unsent question');
  });

  it('keeps the entire window inside the area while dragging past any edge', () => {
    render(<Host />);
    drag(title(), [720, 330], [720 - 2000, 330 + 2000]);
    expect(box()).toMatchObject({ left: '18px', top: '262px' });
    release();
    expect(box()).toMatchObject({ left: '18px', top: '262px' });
    drag(title(), [120, 820], [120, -2000]);
    release();
    expect(box()).toMatchObject({ left: '18px', top: '18px' });
    // Drag toward the right edge while keeping the pointer clear of docking.
    drag(title(), [120, 70], [1020, 70]);
    release();
    drag(title(), [820, 70], [910, 70]);
    release();
    expect(box()).toMatchObject({ left: '598px', top: '18px' });
    expect(area().dataset.form).toBe('float');
  });

  it('refits the window when the area shrinks, including during a drag', () => {
    render(<Host />);
    drag(title(), [720, 330], [740, 350]);
    const original = { ...AREA };
    try {
      Object.assign(AREA, { width: 300, height: 250 });
      fireEvent(window, new Event('resize'));
      expect(box()).toEqual({ left: '18px', top: '18px', width: '264px', height: '214px' });
      release();
      expect(box()).toEqual({ left: '18px', top: '18px', width: '264px', height: '214px' });
    } finally {
      Object.assign(AREA, original);
    }
  });

  it('does not start a drag from the title bar buttons', () => {
    render(<Host />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Minimize' }), { button: 0, clientX: 900, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 100 });
    expect(box()).toMatchObject({ left: '598px', top: '262px' });
  });

  it('resizes from a corner down to 320×300 and shows the size while dragging', () => {
    render(<Host />);
    drag(panel().querySelector('[data-dir="se"]')!, [1082, 832], [500, 300]);
    expect(box()).toMatchObject({ width: '320px', height: '300px' });
    expect(screen.getByText('320 × 300')).toBeTruthy();
    release();
    expect(screen.queryByText('320 × 300')).toBeNull();
    drag(panel().querySelector('[data-dir="nw"]')!, [698, 312], [598, 212]);
    release();
    expect(box()).toEqual({ left: '498px', top: '162px', width: '420px', height: '400px' });
  });

  it('shows the dock frame at the right edge, hides it away from the edge, and docks on release', () => {
    render(<Host />);
    const ghost = () => document.querySelector('.meta-chat-dock-ghost') as HTMLElement;
    drag(title(), [720, 330], [1095, 330]);
    expect(ghost().hasAttribute('data-on')).toBe(true);
    expect(ghost().textContent).toBe('Release to dock as half screen');
    fireEvent.pointerMove(window, { clientX: 800, clientY: 330 });
    expect(ghost().hasAttribute('data-on')).toBe(false);
    fireEvent.pointerMove(window, { clientX: 1099, clientY: 330 });
    release();
    expect(area().dataset.form).toBe('dock');
    expect(screen.getByRole('separator')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to floating' }));
    expect(box()).toEqual({ left: '598px', top: '262px', width: '384px', height: '520px' });
  });

  it('docks from the button and returns to the last floating box', () => {
    render(<Host />);
    drag(title(), [720, 330], [520, 230]);
    release();
    fireEvent.click(screen.getByRole('button', { name: 'Dock as half screen' }));
    expect(area().dataset.form).toBe('dock');
    expect(pageEl().style.flexBasis).toBe('50%');
    expect(panel().style.left).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Back to floating' }));
    expect(box()).toEqual({ left: '398px', top: '162px', width: '384px', height: '520px' });
  });

  it('clamps the divider to 30–70 and shows the split while dragging', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Dock as half screen' }));
    const divider = screen.getByRole('separator');
    drag(divider, [600, 400], [150, 400]);
    expect(screen.getByText('30 : 70')).toBeTruthy();
    expect(pageEl().style.flexBasis).toBe('30%');
    fireEvent.pointerMove(window, { clientX: 1090, clientY: 400 });
    expect(screen.getByText('70 : 30')).toBeTruthy();
    release();
    expect(screen.queryByText('70 : 30')).toBeNull();
    expect(divider.getAttribute('aria-valuenow')).toBe('30');
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(divider.getAttribute('aria-valuenow')).toBe('35');
  });

  it('minimizes to the pill and restores the previous form', async () => {
    render(<Host />);
    await screen.findByLabelText('Message the assistant');
    fireEvent.click(screen.getByRole('button', { name: 'Dock as half screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(panel().hidden).toBe(true);
    expect(pageEl().style.flexBasis).toBe('');
    const launcher = screen.getByRole('button', { name: 'Ask assistant' });
    expect(launcher.textContent).toBe('');
    expect(launcher.getAttribute('title')).toMatch(/^Ask assistant \(.+J\)$/);
    expect(launcher.querySelector('svg')).toBeTruthy();
    fireEvent.click(launcher);
    expect(area().dataset.form).toBe('dock');
    expect(document.activeElement).toBe(screen.getByLabelText('Message the assistant'));
  });

  it('a labelled pill reads its label, and starts minimized when asked to, until the user opens it', () => {
    // The Meta agent's first run is reading, but that is not this window's work.
    firstRun.data = { requestedAt: 1, summary: { state: 'waiting', summarizedAt: null }, haltedReason: null,
      workspaces: [{ workspaceId: 'a', workspaceName: 'a', homePageId: null, hiddenAt: null,
        firstRun: { workspaceId: 'a', startedAt: 1, startSeq: 1, readCount: 2, total: 9, state: 'reading', error: null, updatedAt: 1 } }] };
    render(<Host options={{ storage: null, initialState: { minimized: true } }} pillLabel="Create with agent" firstRunDot={false} />);
    expect(area().dataset.form).toBe('min');
    const launcher = screen.getByRole('button', { name: 'Create with agent' });
    expect(launcher.textContent).toBe('Create with agent');
    expect(launcher.getAttribute('title')).toBe('Create with agent');
    expect(launcher.hasAttribute('data-labelled')).toBe(true);
    expect(screen.queryByRole('status', { name: 'Assistant is working' })).toBeNull();
    fireEvent.click(launcher);
    expect(area().dataset.form).toBe('float');
  });

  it('toggles with ⌘J and Ctrl+J only while visible and enabled', () => {
    const view = render(<Host />);
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(area().dataset.form).toBe('min');
    fireEvent.keyDown(window, { key: 'J', ctrlKey: true });
    expect(area().dataset.form).toBe('float');
    fireEvent.keyDown(window, { key: 'j', metaKey: true, shiftKey: true });
    expect(area().dataset.form).toBe('float');
    view.rerender(<Host visible={false} />);
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    view.rerender(<Host visible />);
    expect(area().dataset.form).toBe('float');
    view.rerender(<Host shortcut={false} />);
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(area().dataset.form).toBe('float');
  });

  it('hides outside Spaces and comes back with its state and draft', async () => {
    const view = render(<Host />);
    await screen.findByLabelText('Message the assistant');
    fireEvent.click(screen.getByRole('button', { name: 'Dock as half screen' }));
    fireEvent.change(screen.getByLabelText('Message the assistant'), { target: { value: 'half typed' } });
    const page = screen.getByTestId('page');
    view.rerender(<Host visible={false} />);
    expect(area().dataset.form).toBe('hidden');
    expect(panel().hidden).toBe(true);
    expect(pageEl().style.flexBasis).toBe('');
    expect(screen.queryByRole('separator')).toBeNull();
    view.rerender(<Host visible pageName="Michi 0.9 release" />);
    expect(area().dataset.form).toBe('dock');
    expect(screen.getByTestId('page')).toBe(page);
    expect((screen.getByLabelText('Message the assistant') as HTMLTextAreaElement).value).toBe('half typed');
    expect(viewing()).toBe('Viewing: Michi 0.9 release');
  });

  it('disables suggestions while busy and marks the pill', () => {
    const onSuggestion = vi.fn();
    const suggestions = [{ id: 'wait', label: 'Which threads are waiting on me?' }];
    const view = render(<Host suggestions={suggestions} onSuggestion={onSuggestion} />);
    fireEvent.click(screen.getByRole('button', { name: suggestions[0].label }));
    expect(onSuggestion).toHaveBeenCalledWith(suggestions[0]);
    view.rerender(<Host suggestions={suggestions} onSuggestion={onSuggestion} busy />);
    expect((screen.getByRole('button', { name: suggestions[0].label }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.getByRole('status', { name: 'Assistant is working' })).toBeTruthy();
  });

  it('marks the pill while the first run reads in the background, with no answer streaming', () => {
    firstRun.data = { requestedAt: 1, summary: { state: 'waiting', summarizedAt: null }, haltedReason: null,
      workspaces: [{ workspaceId: 'a', workspaceName: 'a', homePageId: null, hiddenAt: null,
        firstRun: { workspaceId: 'a', startedAt: 1, startSeq: 1, readCount: 2, total: 9, state: 'reading', error: null, updatedAt: 1 } }] };
    const view = render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.getByRole('status', { name: 'Assistant is working' })).toBeTruthy();
    firstRun.data = null;
    view.rerender(<Host />);
    expect(screen.queryByRole('status', { name: 'Assistant is working' })).toBeNull();
    // A Spaces Home summary after the first run is background upkeep, not the window working.
    firstRun.data = { requestedAt: 1, summary: { state: 'running', summarizedAt: 5 }, haltedReason: null, closed: true,
      workspaces: [{ workspaceId: 'a', workspaceName: 'a', homePageId: null, hiddenAt: null,
        firstRun: { workspaceId: 'a', startedAt: 1, startSeq: 1, readCount: 9, total: 9, state: 'done', error: null, updatedAt: 1 } }] };
    view.rerender(<Host />);
    expect(screen.queryByRole('status', { name: 'Assistant is working' })).toBeNull();
  });

  it('tells the page to lay out narrow only while docked', () => {
    render(<Host />);
    expect(screen.getByTestId('page').hasAttribute('data-narrow')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Dock as half screen' }));
    expect(area().dataset.form).toBe('dock');
    expect(screen.getByTestId('page').hasAttribute('data-narrow')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.getByTestId('page').hasAttribute('data-narrow')).toBe(false);
  });

  it('shows the target chip and submits on Enter', async () => {
    const onClearTarget = vi.fn();
    const onSubmit = vi.fn();
    render(<Host target={{ label: 'Next steps' }} onClearTarget={onClearTarget} onSubmit={onSubmit} />);
    expect(screen.getByText('Targeting: Next steps')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear target' }));
    expect(onClearTarget).toHaveBeenCalledTimes(1);
    const input = await screen.findByLabelText('Message the assistant');
    fireEvent.change(input, { target: { value: '  tighten this  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('tighten this');
    expect((input as HTMLTextAreaElement).value).toBe('');
  });

  it('writes storage only when a drag commits, never on StrictMode mount or unmount', () => {
    localStorage.setItem(METACHAT_STORAGE_KEY, JSON.stringify({ form: 'float' }));
    const setItem = vi.spyOn(localStorage, 'setItem');
    const view = render(<StrictMode><Host options={{}} /></StrictMode>);
    expect(setItem).not.toHaveBeenCalled();
    drag(title(), [720, 330], [520, 230]);
    expect(setItem).not.toHaveBeenCalled();
    act(() => { release(); });
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(METACHAT_STORAGE_KEY)!).rect).toEqual({ x: 398, y: 162, w: 384, h: 520 });
    view.unmount();
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  describe('the first open, before the user placed it', () => {
    function PageWithColumn() {
      return <main className="area-settings"><div className="area-settings__doc" style={{ paddingLeft: '56px', paddingRight: '56px' }}>page</div></main>;
    }
    function FirstHost({ withColumn = true, strict = false }: { withColumn?: boolean; strict?: boolean }) {
      const chat = useMetaChatWindow();
      const area = (
        <MetaChatArea controller={chat} pageName="Home">
          {withColumn ? <PageWithColumn /> : <Page />}
        </MetaChatArea>
      );
      return strict ? <StrictMode>{area}</StrictMode> : area;
    }
    const pill = () => screen.queryByRole('button', { name: /Ask assistant/ });

    it('opens minimised, without writing storage, when the window would cover the page column', () => {
      // The column's text runs from 160 to 940 of the 1000 px area: no box fits beside it.
      column.rect = { left: 100 + 104, top: 50, width: 892, height: 2000 };
      const setItem = vi.spyOn(localStorage, 'setItem');
      render(<FirstHost strict />);
      expect(area().dataset.form).toBe('min');
      expect(pill()).toBeTruthy();
      expect(setItem).not.toHaveBeenCalled();
      fireEvent.click(pill()!);
      expect(box()).toEqual({ left: '598px', top: '262px', width: '384px', height: '520px' });
      expect(JSON.parse(localStorage.getItem(METACHAT_STORAGE_KEY)!)).toMatchObject({ form: 'float', minimized: false });
    });

    it('floats in its default box when the column leaves room, and assumes the Spaces column before the page renders one', () => {
      column.rect = { left: 100, top: 50, width: 600, height: 2000 };
      const view = render(<FirstHost />);
      expect(area().dataset.form).toBe('float');
      expect(box()).toEqual({ left: '598px', top: '262px', width: '384px', height: '520px' });
      view.unmount();
      render(<FirstHost withColumn={false} />);
      expect(area().dataset.form).toBe('min');
    });

    it('never moves a window the user placed, at any width', () => {
      localStorage.setItem(METACHAT_STORAGE_KEY, JSON.stringify({ form: 'float', minimized: false, rect: { x: 300, y: 100, w: 384, h: 520 } }));
      column.rect = { left: 100 + 104, top: 50, width: 892, height: 2000 };
      render(<FirstHost />);
      expect(area().dataset.form).toBe('float');
      expect(box()).toEqual({ left: '300px', top: '100px', width: '384px', height: '520px' });
    });
  });

  it('restores a stored box clamped to the current area', () => {
    localStorage.setItem(METACHAT_STORAGE_KEY, JSON.stringify({ form: 'float', rect: { x: 5000, y: 5000, w: 600, h: 2000 }, dockRatio: 40 }));
    render(<Host options={{}} />);
    expect(box()).toEqual({ left: '382px', top: '18px', width: '600px', height: '764px' });
  });

  it('opens full screen on a touch phone without putting the cursor in the composer', async () => {
    await onTouchPhone(async () => {
      render(<Host />);
      const input = await screen.findByLabelText('Message the assistant');
      fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
      fireEvent.click(screen.getByRole('button', { name: 'Ask assistant' }));
      expect(area().dataset.form).toBe('full');
      expect(document.activeElement).not.toBe(input);
    });
  });

  it('minimizes when a page link in it opens the page it covers: on a phone, and in full screen', async () => {
    openSpacesPage.mockResolvedValue('opened');
    const conversation = <PageLinkChip id="pg-l">L</PageLinkChip>;
    const view = render(<Host conversation={conversation} />);
    fireEvent.click(screen.getByRole('button', { name: 'L' }));
    expect(openSpacesPage).toHaveBeenCalledWith({ pageId: 'pg-l' });
    expect(area().dataset.form).toBe('float');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'L' }));
    expect(area().dataset.form).toBe('min');
    view.unmount();
    await onTouchPhone(() => {
      render(<Host conversation={conversation} />);
      expect(area().dataset.form).toBe('full');
      fireEvent.click(screen.getByRole('button', { name: 'L' }));
      expect(area().dataset.form).toBe('min');
    });
  });
});
