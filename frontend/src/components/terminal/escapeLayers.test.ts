import { afterEach, describe, expect, it } from 'vitest';
import { markComposerEscape } from '../composerEscape';
import { escapeIsForPage, isInAssistantPanel } from './escapeLayers';

function escape(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init });
  let seen: boolean | null = null;
  let seenAll: boolean | null = null;
  const listen = (e: Event) => { seen = escapeIsForPage(e as KeyboardEvent); };
  const listenAll = (e: Event) => { seenAll = escapeIsForPage(e as KeyboardEvent, 'all'); };
  document.addEventListener('keydown', listen);
  document.addEventListener('keydown', listenAll);
  target.dispatchEvent(event);
  document.removeEventListener('keydown', listen);
  document.removeEventListener('keydown', listenAll);
  return { menus: seen, all: seenAll };
}

function add(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => { document.body.innerHTML = ''; });

describe('escapeIsForPage', () => {
  it('leaves a plain Esc on the page to the page', () => {
    const host = add('<button>Row</button>');
    expect(escape(host.querySelector('button')!)).toEqual({ menus: true, all: true });
    expect(escape(document.body)).toEqual({ menus: true, all: true });
  });

  it('is not the page’s when it is another key', () => {
    const event = new KeyboardEvent('keydown', { key: 'Enter' });
    expect(escapeIsForPage(event)).toBe(false);
  });

  it('never lets an Esc pressed inside the assistant panel reach the page', () => {
    const host = add('<div data-assistant-panel><button>Permissions: Ask</button></div>');
    const chip = host.querySelector('button')!;
    expect(isInAssistantPanel(chip)).toBe(true);
    expect(escape(chip)).toEqual({ menus: false, all: false });
  });

  it('is not the page’s once something handled it, or the composer kept it', () => {
    const host = add('<button>Row</button>');
    const button = host.querySelector('button')!;
    button.addEventListener('keydown', (e) => e.preventDefault(), { once: true });
    expect(escape(button)).toEqual({ menus: false, all: false });
    button.addEventListener('keydown', (e) => markComposerEscape(e), { once: true });
    expect(escape(button)).toEqual({ menus: false, all: false });
    expect(escape(button, { isComposing: true } as KeyboardEventInit)).toEqual({ menus: false, all: false });
  });

  it('is not the page’s when it comes from inside an Esc layer (find bar, selection toolbar)', () => {
    const host = add('<div data-escape-layer="pane"><button>next</button></div>');
    expect(escape(host.querySelector('button')!)).toEqual({ menus: false, all: false });
  });

  it('leaves it to an open menu, list or modal wherever the focus is, whichever listener runs first', () => {
    for (const layer of ['<div role="menu"></div>', '<div role="listbox"></div>', '<div role="alertdialog"></div>', '<div aria-modal="true"></div>', '<div data-escape-layer="over"></div>']) {
      const host = add(layer);
      expect(escape(document.body)).toEqual({ menus: false, all: false });
      host.remove();
    }
    // A modal drawer sliding out (aria-hidden) no longer counts.
    const sliding = add('<div role="dialog" aria-modal="true" aria-hidden="true"></div>');
    expect(escape(document.body).menus).toBe(true);
    sliding.remove();
  });

  it('counts a non-modal drawer, the find bar and the sidebar overlay only for the shell under everything', () => {
    for (const layer of ['<div role="dialog"></div>', '<div data-escape-layer="pane"></div>', '<div data-escape-layer="shell"></div>']) {
      const host = add(layer);
      expect(escape(document.body)).toEqual({ menus: true, all: false });
      host.remove();
    }
  });
});
