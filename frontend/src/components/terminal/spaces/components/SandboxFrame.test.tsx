import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { componentSandboxUrl, SandboxFrame } from './SandboxFrame';

describe('componentSandboxUrl', () => {
  it.each([
    ['http://localhost:3000/api', 'http://127.0.0.1:3001/', 'http://127.0.0.1:3000/api/component-sandbox-wrapper'],
    ['http://127.0.0.1:3000/api', 'http://localhost:4387/', 'http://localhost:3000/api/component-sandbox-wrapper'],
    ['http://localhost:3000/api/backend-connections/remote/proxy', 'http://127.0.0.1:3001/', 'http://127.0.0.1:3000/api/backend-connections/remote/proxy/component-sandbox-wrapper'],
    ['/api', 'http://127.0.0.1:52249/', '/api/component-sandbox-wrapper'],
    ['https://gateway.example/api', 'http://127.0.0.1:3001/', 'https://gateway.example/api/component-sandbox-wrapper'],
    ['http://localhost:3000/api', 'https://michi.example/', 'http://localhost:3000/api/component-sandbox-wrapper'],
    ['http://localhost:3000/api', 'http://localhost:3001/', 'http://localhost:3000/api/component-sandbox-wrapper'],
  ])('loads %s from %s without changing the owning backend', (apiBase, renderer, expected) => {
    expect(componentSandboxUrl(apiBase, renderer)).toBe(expected);
  });
});

describe('SandboxFrame', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.useRealTimers());

  function handshake(frame: HTMLIFrameElement) {
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    const { channel } = post.mock.calls.map(([message]) => message as { type: string; channel: string }).find(message => message.type === 'michi-component:wrapper-init')!;
    const send = (message: Record<string, unknown>) => act(() => {
      window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { channel, ...message } }));
    });
    send({ type: 'michi-component:wrapper-ready' });
    return { post, send };
  }

  it('keeps the same old iframe until a replacement actually renders; candidates cannot cause side effects', async () => {
    const capability = { token: 'capability', call: vi.fn().mockResolvedValue({}) };
    const props = { connectionId: 'local', name: 'Live', props: {}, data: {}, stable: true, capability };
    const { rerender, container } = render(<SandboxFrame {...props} code="first" versionKey={1} />);
    const old = screen.getByTitle('Live preview') as HTMLIFrameElement;
    const first = handshake(old);
    expect(old.closest('[data-staged]')).not.toBeNull();
    first.send({ type: 'michi-component:rendered' });
    expect(old.closest('[data-staged]')).toBeNull();
    rerender(<SandboxFrame {...props} code="second" versionKey={2} />);
    expect(container.querySelector('iframe')).toBe(old);
    expect(first.post.mock.calls.some(([message]) => message.type === 'michi-component:freeze')).toBe(true);
    const replacement = container.querySelector('[data-staged] iframe') as HTMLIFrameElement;
    const next = handshake(replacement);
    next.send({ type: 'michi-component:call', id: 1, method: 'write.rows', args: [] });
    next.send({ type: 'michi-component:call', id: 2, method: 'ask.draft', args: ['do it'] });
    first.send({ type: 'michi-component:call', id: 3, method: 'write.rows', args: [] });
    expect(capability.call).not.toHaveBeenCalled();
    next.send({ type: 'michi-component:call', id: 4, method: 'read.host', args: [] });
    await waitFor(() => expect(capability.call).toHaveBeenCalledWith('read.host', []));
    expect(container.querySelector('iframe')).toBe(old);
    next.send({ type: 'michi-component:rendered' });
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(container.querySelector('iframe')).toBe(replacement);
    expect(replacement.closest('[data-staged]')).toBeNull();
    next.send({ type: 'michi-component:call', id: 5, method: 'write.rows', args: [] });
    await waitFor(() => expect(capability.call).toHaveBeenCalledWith('write.rows', []));
  });

  it.each(['error', 'timeout'])('retains the last rendered frame when the candidate fails with %s', (failure) => {
    if (failure === 'timeout') vi.useFakeTimers();
    const props = { connectionId: 'local', name: 'Kept', props: {}, data: {}, stable: true };
    const { rerender, container } = render(<SandboxFrame {...props} code="first" />);
    const old = screen.getByTitle('Kept preview') as HTMLIFrameElement;
    handshake(old).send({ type: 'michi-component:rendered' });
    rerender(<SandboxFrame {...props} code="broken" />);
    const next = handshake(container.querySelector('[data-staged] iframe') as HTMLIFrameElement);
    if (failure === 'error') next.send({ type: 'michi-component:error', message: 'Bad code' });
    else act(() => vi.advanceTimersByTime(10_000));
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    expect(container.querySelector('iframe')).toBe(old);
    expect(screen.getByRole('status').textContent).toContain('The previous view is kept');
    rerender(<SandboxFrame {...props} code="fixed" scopeKey="another-host" />);
    expect(container.querySelector('iframe')).not.toBe(old);
  });

  it('waits for the fixed wrapper handshake and updates props/data without reposting code', () => {
    const { rerender } = render(<SandboxFrame connectionId="local" name="Risk chart" code="root.textContent = props.title" props={{ title: 'First' }} data={{ risk: 2 }} />);
    const frame = screen.getByTitle('Risk chart preview') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    const init = post.mock.calls.find(([message]) => (message as { type?: string }).type === 'michi-component:wrapper-init')?.[0] as { channel: string } | undefined;
    expect(init?.channel.length).toBeGreaterThanOrEqual(24);
    expect(post.mock.calls.some(([message]) => (message as { type?: string }).type === 'michi-component:load')).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:wrapper-ready', channel: init?.channel } }));
    const load = post.mock.calls.find(([message]) => (message as { type?: string }).type === 'michi-component:load')?.[0] as { channel: string; code: string } | undefined;
    expect(load?.code).toContain('props.title');
    expect(load?.channel.length).toBeGreaterThanOrEqual(24);

    rerender(<SandboxFrame connectionId="local" name="Risk chart" code="root.textContent = props.title" props={{ title: 'Updated' }} data={{ risk: 4 }} />);
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'michi-component:load')).toHaveLength(1);
    expect(post.mock.calls.some(([message]) => (message as { type?: string }).type === 'michi-component:update')).toBe(true);
  });

  it('stops after a second document load and never sends the channel or code again', () => {
    render(<SandboxFrame connectionId="local" name="Unsafe component" code="root.textContent = 'hello'" props={{}} data={{ secret: 'sample' }} />);
    const frame = screen.getByTitle('Unsafe component preview') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    const init = post.mock.calls.map(([message]) => message as { type?: string; channel?: string }).find(message => message.type === 'michi-component:wrapper-init');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:wrapper-ready', channel: init?.channel } }));
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'michi-component:load')).toHaveLength(1);
    fireEvent.load(frame);
    expect(screen.getByRole('status').textContent).toContain('Component stopped');
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'michi-component:load')).toHaveLength(1);
    expect(screen.queryByTitle('Unsafe component preview')).toBeNull();
  });

  it('denies preview bridge calls and loads only sample data', () => {
    const capability = { token: 'must-not-be-used', call: vi.fn().mockResolvedValue({}) };
    render(<SandboxFrame connectionId="local" name="Preview" code="root.textContent = 'sample'" props={{}} data={{ private: 'caller data' }} preview capability={capability} />);
    const frame = screen.getByTitle('Preview preview') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    const init = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:wrapper-init');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:wrapper-ready', channel: init?.channel } }));
    const load = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:load');
    expect(load?.data).toEqual({ sample: true, value: 12, label: 'Example' });
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:call', channel: load?.channel, id: 2, method: 'read.host', args: [] } }));
    expect(capability.call).not.toHaveBeenCalled();
  });

  it('uses shared height and draft limits for live component actions', async () => {
    const capability = { token: 'capability', call: vi.fn().mockResolvedValue({ text: 'ok' }) };
    const onAskDraft = vi.fn();
    render(<SandboxFrame connectionId="local" name="Limits" code="root.textContent = 'limits'" props={{}} data={{}} capability={capability} onAskDraft={onAskDraft} />);
    const frame = screen.getByTitle('Limits preview') as HTMLIFrameElement;
    expect(frame.style.height).toBe('80px');
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    const init = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:wrapper-init');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:wrapper-ready', channel: init?.channel } }));
    const load = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:load');
    act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:call', channel: load?.channel, id: 1, method: 'resize', args: [2000] } })));
    expect(frame.style.height).toBe('1600px');
    const draft = 'd'.repeat(8000);
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:call', channel: load?.channel, id: 2, method: 'ask.draft', args: [draft] } }));
    await waitFor(() => expect(onAskDraft).toHaveBeenCalledWith(draft));
  });

  it('does not run a resolved host action after the component version changes', async () => {
    let resolveCapability!: (value: unknown) => void;
    const capability = { token: 'capability', call: vi.fn(() => new Promise(resolve => { resolveCapability = resolve; })) };
    const onAskDraft = vi.fn();
    const { rerender } = render(<SandboxFrame connectionId="local" name="Action" code="root.textContent = 'first'" props={{}} data={{}} capability={capability} onAskDraft={onAskDraft} />);
    const frame = screen.getByTitle('Action preview') as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    const init = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:wrapper-init');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:wrapper-ready', channel: init?.channel } }));
    const load = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:load');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:call', channel: load?.channel, id: 1, method: 'ask.draft', args: ['stale draft'] } }));
    expect(capability.call).toHaveBeenCalledOnce();

    rerender(<SandboxFrame connectionId="local" name="Action" code="root.textContent = 'second'" props={{}} data={{}} capability={capability} onAskDraft={onAskDraft} />);
    resolveCapability({ text: 'stale draft' });
    await Promise.resolve();
    await Promise.resolve();
    expect(onAskDraft).not.toHaveBeenCalled();
  });

  it('gives the component the palette it sits in, and the next one when it changes', async () => {
    const { container } = render(<div style={{ '--term-bg': '#101010', '--term-fg': '#eeeeee', '--term-accent': 'url(https://t.example/x)' } as React.CSSProperties}>
      <SandboxFrame connectionId="local" name="Themed" code="root.textContent = 'themed'" props={{}} data={{}} />
    </div>);
    const palette = container.firstElementChild as HTMLElement;
    const frame = screen.getByTitle('Themed preview') as HTMLIFrameElement;
    // jsdom does not inherit custom properties; a browser does, from the palette's element down to the frame.
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element) => ({
      getPropertyValue: (name: string) => {
        for (let at: Element | null = element; at; at = at.parentElement) {
          const value = (at as HTMLElement).style?.getPropertyValue(name);
          if (value) return value;
        }
        return '';
      },
    }) as CSSStyleDeclaration);
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    fireEvent.load(frame);
    const init = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:wrapper-init');
    window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { type: 'michi-component:wrapper-ready', channel: init?.channel } }));
    const load = post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:load');
    // A value that would load something never reaches the frame.
    expect(load?.theme).toEqual({ '--term-bg': '#101010', '--term-fg': '#eeeeee' });

    palette.style.setProperty('--term-fg', '#222222');
    await waitFor(() => expect(post.mock.calls.map(([message]) => message as Record<string, unknown>).find(message => message.type === 'michi-component:theme'))
      .toEqual({ type: 'michi-component:theme', channel: load?.channel, theme: { '--term-bg': '#101010', '--term-fg': '#222222' } }));
    palette.style.setProperty('--term-composer-bg', '#ffffff');
    palette.setAttribute('data-x', '1');
    await Promise.resolve();
    expect(post.mock.calls.filter(([message]) => (message as { type?: string }).type === 'michi-component:theme')).toHaveLength(1);
  });
});
