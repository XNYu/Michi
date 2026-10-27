import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMPONENT_SANDBOX_IFRAME, COMPONENT_SANDBOX_METHODS, COMPONENT_SANDBOX_THEME_VARS, COMPONENT_SANDBOX_TIMEOUT_MS, PAGE_COMPONENT_LIMITS, isComponentSandboxThemeValue, parseComponentSandboxMessage, type ComponentSandboxMethod, type ComponentSandboxTheme } from 'michi-shared';
import { backendApiBase } from '../../../../config/backendConnections';
import './components.css';

export interface SandboxFrameProps {
  connectionId: string;
  name: string;
  code: string;
  versionKey?: string | number;
  props: Record<string, unknown>;
  data: unknown;
  preview?: boolean;
  initialHeight?: number;
  capability?: { id?: string; token: string; call(method: ComponentSandboxMethod, args: unknown[]): Promise<unknown> };
  minHeight?: number;
  maxHeight?: number;
  onAskDraft?: (draft: string) => void;
  onNavigate?: (pageId: string) => void;
  onRuntimeError?: (message: string) => void;
  onStop?: () => void;
  /** Keep the last successful frame until a replacement has applied its first render tree. */
  stable?: boolean;
  /** Stable host identity; changing it must discard any retained frame. */
  scopeKey?: string;
  /** A replacement waits for authorized host data before it starts. */
  candidateReady?: boolean;
  onPresented?: () => void;
}

function channelId(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') || `${Date.now()}-${Math.random()}-${Math.random()}`;
}
function safePost(win: Window, payload: unknown): boolean { try { win.postMessage(payload, '*'); return true; } catch { return false; } }

/** Iframe navigations have no Origin header. Keep local dev requests same-site so the API guard can accept them. */
export function componentSandboxUrl(apiBase: string, rendererUrl: string): string {
  const src = `${apiBase}/component-sandbox-wrapper`;
  const backend = new URL(src, rendererUrl);
  const renderer = new URL(rendererUrl);
  const localHosts = new Set(['localhost', '127.0.0.1']);
  if (backend.protocol === renderer.protocol && backend.hostname !== renderer.hostname
    && localHosts.has(backend.hostname) && localHosts.has(renderer.hostname)) {
    backend.hostname = renderer.hostname;
    return backend.href;
  }
  return src;
}

/** The palette and type where the frame sits: the theme variables it inherits, those with safe values. */
export function sandboxThemeAt(element: Element | null): ComponentSandboxTheme {
  const theme: ComponentSandboxTheme = {};
  if (!element) return theme;
  const style = getComputedStyle(element);
  for (const name of COMPONENT_SANDBOX_THEME_VARS) {
    const value = style.getPropertyValue(name).trim();
    if (isComponentSandboxThemeValue(value)) theme[name] = value;
  }
  return theme;
}

export function SandboxFrame(input: SandboxFrameProps) {
  return input.stable && !input.preview
    ? <StableSandboxFrame key={`${input.connectionId}:${input.scopeKey ?? ''}`} {...input} />
    : <SandboxRunner {...input} mode="active" />;
}

/** The retained frame is presentation only: its worker and authority stop as soon as a replacement arrives. */
function StableSandboxFrame(input: SandboxFrameProps) {
  const [retry, setRetry] = useState(0);
  const definition = JSON.stringify([input.code, input.versionKey, retry]);
  const [request, setRequest] = useState({ definition, sequence: 1 });
  const current = request.definition === definition ? request : { definition, sequence: request.sequence + 1 };
  if (current !== request) setRequest(current);
  const latestSequence = useRef(current.sequence);
  latestSequence.current = current.sequence;
  const [displayed, setDisplayed] = useState<{ sequence: number; input: SandboxFrameProps } | null>(null);
  const [failed, setFailed] = useState<{ sequence: number; message: string } | null>(null);
  const isCurrent = displayed?.sequence === current.sequence;
  const failure = failed?.sequence === current.sequence ? failed.message : null;
  const candidates = [];
  if (displayed && !isCurrent) candidates.push(
    <div key={displayed.sequence} className="page-component-slot" data-retained="" inert={true}>
      <SandboxRunner {...displayed.input} mode="retained" capability={undefined} onRuntimeError={undefined} onStop={undefined} />
    </div>,
  );
  if (isCurrent || (input.candidateReady !== false && !failure)) candidates.push(
    <div key={current.sequence} className="page-component-slot" data-staged={!isCurrent || undefined} aria-hidden={!isCurrent || undefined} inert={!isCurrent}>
      <SandboxRunner {...input} mode={isCurrent ? 'active' : 'candidate'} onRendered={() => {
        if (latestSequence.current === current.sequence) { setDisplayed({ sequence: current.sequence, input }); input.onPresented?.(); }
      }} onRuntimeError={(message) => {
        if (latestSequence.current !== current.sequence) return;
        if (!isCurrent) setFailed({ sequence: current.sequence, message });
        input.onRuntimeError?.(message);
      }} />
    </div>,
  );
  return <div className="page-component-stable">
    {!displayed && !failure && <div className="page-component-loading" role="status">Loading component…</div>}
    {candidates}
    {failure && <div className="page-component-error" role="status">
      <p>{displayed ? 'The update could not be displayed. The previous view is kept.' : 'The component could not be displayed.'} {failure}</p>
      <button type="button" onClick={() => setRetry(value => value + 1)}>Retry update</button>
    </div>}
  </div>;
}

type RunnerMode = 'active' | 'candidate' | 'retained';

/** Runs generated code in the owning backend's fixed opaque-origin document. Preview frames have no bridge. */
function SandboxRunner({ connectionId, name, code, versionKey, props, data, preview = false, initialHeight, capability, minHeight = PAGE_COMPONENT_LIMITS.heightMin, maxHeight = PAGE_COMPONENT_LIMITS.heightMax, onAskDraft, onNavigate, onRuntimeError, onStop, mode, onRendered }: SandboxFrameProps & { mode: RunnerMode; onRendered?: () => void }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [mount, setMount] = useState(0);
  const channel = useMemo(channelId, [code, mount, versionKey]);
  const channelRef = useRef(channel);
  channelRef.current = channel;
  const mountRef = useRef(mount);
  mountRef.current = mount;
  const live = useRef(false);
  const loads = useRef(0);
  const ready = useRef(false);
  const rendered = useRef(false);
  const sent = useRef('');
  const themeSent = useRef('');
  const calls = useRef<number[]>([]);
  const reloads = useRef<number[]>([]);
  const pending = useRef(0);
  const [showCode, setShowCode] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [height, setHeight] = useState(Math.max(minHeight, Math.min(maxHeight, initialHeight ?? minHeight)));
  const [failure, setFailure] = useState<string | null>(null);
  const src = componentSandboxUrl(backendApiBase(connectionId), window.location.href);
  const signature = JSON.stringify([props, data]);
  const latest = useRef({ code, props, data, preview, signature, capability, minHeight, maxHeight, onAskDraft, onNavigate, onRuntimeError, onStop, mode, onRendered });
  latest.current = { code, props, data, preview, signature, capability, minHeight, maxHeight, onAskDraft, onNavigate, onRuntimeError, onStop, mode, onRendered };

  useEffect(() => { loads.current = 0; live.current = false; rendered.current = false; sent.current = ''; pending.current = 0; }, [code, mount, versionKey]);
  useEffect(() => {
    if (mode !== 'retained') return;
    live.current = false; ready.current = false; pending.current = 0;
    const win = iframe.current?.contentWindow;
    if (win) safePost(win, { type: 'michi-component:freeze', channel });
  }, [channel, mode]);
  useEffect(() => {
    if (mode !== 'candidate') return;
    const timer = window.setTimeout(() => {
      if (rendered.current) return;
      live.current = false; ready.current = false;
      const win = iframe.current?.contentWindow;
      if (win) safePost(win, { type: 'michi-component:freeze', channel });
      latest.current.onRuntimeError?.('The first render timed out.');
    }, COMPONENT_SANDBOX_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [channel, mode]);
  useEffect(() => { setHeight(Math.max(minHeight, Math.min(maxHeight, initialHeight ?? minHeight))); }, [initialHeight, maxHeight, minHeight]);

  const onLoad = useCallback(() => {
    const win = iframe.current?.contentWindow;
    if (!win || latest.current.mode === 'retained') return;
    try { if (win.location.href === 'about:blank') return; } catch { /* The actual sandbox has an opaque origin. */ }
    if (++loads.current > 1) { live.current = false; ready.current = false; pending.current = 0; setStopped(true); setFailure('The component sandbox document changed. It has been stopped for safety.'); latest.current.onStop?.(); return; }
    // Only the channel is sent before the fixed sandbox document confirms readiness.
    // Component source and data stay in the child Blob Worker after that handshake.
    safePost(win, { type: 'michi-component:wrapper-init', channel });
  }, [channel]);

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const win = iframe.current?.contentWindow;
      if (!win || event.source !== win || latest.current.mode === 'retained') return;
      const raw = event.data;
      if (!ready.current && raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'michi-component:wrapper-ready') {
        const readyMessage = raw as { type?: unknown; channel?: unknown };
        if (Object.keys(raw).length !== 2 || readyMessage.channel !== channel) return;
        ready.current = true;
        live.current = true;
        const current = latest.current;
        sent.current = current.signature;
        const theme = sandboxThemeAt(iframe.current);
        themeSent.current = JSON.stringify(theme);
        safePost(win, { type: 'michi-component:load', channel, code: current.code, props: current.props, data: current.preview ? { sample: true, value: 12, label: 'Example' } : current.data, theme });
        return;
      }
      if (!live.current || !ready.current) return;
      const message = parseComponentSandboxMessage(event.data);
      if (!message || message.channel !== channel || channelRef.current !== message.channel) return;
      if (message.type === 'michi-component:rendered') {
        if (!rendered.current) { rendered.current = true; latest.current.onRendered?.(); }
        return;
      }
      if (message.type === 'michi-component:error') {
        const reason = message.message.slice(0, 1000);
        if (latest.current.mode === 'candidate') { live.current = false; ready.current = false; safePost(win, { type: 'michi-component:freeze', channel }); }
        setFailure(reason); latest.current.onRuntimeError?.(reason); return;
      }
      if (message.type !== 'michi-component:call') return;
      const now = Date.now(); calls.current = calls.current.filter(stamp => now - stamp < 1_000);
      if (calls.current.length >= 20) { safePost(win, { type: 'michi-component:result', channel, id: message.id, ok: false, error: 'Too many component requests. Try again shortly.' }); return; }
      calls.current.push(now);
      const callMount = mountRef.current;
      const callChannel = channelRef.current;
      const reply = (ok: boolean, value?: unknown, error?: string) => {
        if (live.current && mountRef.current === callMount && channelRef.current === callChannel && iframe.current?.contentWindow === win) safePost(win, { type: 'michi-component:result', channel: callChannel, id: message.id, ok, ...(value === undefined ? {} : { value }), ...(error ? { error: error.slice(0, 1000) } : {}) });
      };
      const authorizedCall = (method: ComponentSandboxMethod, args: unknown[], success: (value?: unknown) => void) => {
        const current = latest.current;
        const sideEffect = method === 'write.rows' || method === 'navigate.page' || method === 'ask.draft';
        if (current.mode === 'retained' || (sideEffect && current.mode !== 'active')) { reply(false, undefined, 'This component update is not active'); return; }
        if (current.preview || !current.capability) { reply(false, undefined, 'This capability is unavailable'); return; }
        const token = current.capability.token;
        if (pending.current >= 8) { reply(false, undefined, 'Too many component requests are still pending'); return; }
        pending.current += 1;
        let settled = false;
        let timeout = 0;
        const finish = (ok: boolean, value?: unknown, error?: string) => {
          if (settled) return;
          settled = true; window.clearTimeout(timeout); pending.current = Math.max(0, pending.current - 1);
          const stillCurrent = live.current && latest.current.mode !== 'retained' && (!sideEffect || latest.current.mode === 'active')
            && latest.current.capability?.token === token && mountRef.current === callMount && channelRef.current === callChannel && iframe.current?.contentWindow === win;
          if (!stillCurrent) return;
          if (ok) { try { success(value); reply(true, value); } catch (cause) { reply(false, undefined, cause instanceof Error ? cause.message : 'Component action failed'); } } else reply(false, undefined, error);
        };
        timeout = window.setTimeout(() => finish(false, undefined, 'Component request timed out'), 10_000);
        current.capability.call(method, args).then(value => finish(true, value), error => finish(false, undefined, error instanceof Error ? error.message : 'Component request failed'));
      };
      if (message.method === 'resize') {
        const next = Number(message.args[0]);
        if (Number.isFinite(next)) { setHeight(Math.max(latest.current.minHeight, Math.min(latest.current.maxHeight, Math.round(next)))); reply(true); }
        else reply(false, undefined, 'Height must be a number');
        return;
      }
      if (message.method === 'ask.draft') {
        const draft = message.args[0];
        if (!latest.current.preview && typeof draft === 'string' && draft.length > 0 && draft.length <= PAGE_COMPONENT_LIMITS.draftChars && latest.current.onAskDraft) authorizedCall(message.method, message.args, () => latest.current.onAskDraft?.(draft));
        else reply(false, undefined, 'Draft requests are unavailable in preview');
        return;
      }
      if (message.method === 'navigate.page') {
        const pageId = message.args[0];
        if (!latest.current.preview && typeof pageId === 'string' && pageId.length <= 200 && latest.current.onNavigate) authorizedCall(message.method, message.args, value => {
          const authorizedPageId = value && typeof value === 'object' && typeof (value as { pageId?: unknown }).pageId === 'string' ? (value as { pageId: string }).pageId : pageId;
          latest.current.onNavigate?.(authorizedPageId);
        });
        else reply(false, undefined, 'Navigation is unavailable in preview');
        return;
      }
      if (latest.current.preview || !latest.current.capability || !COMPONENT_SANDBOX_METHODS.includes(message.method)) { reply(false, undefined, 'This capability is unavailable'); return; }
      authorizedCall(message.method, message.args, () => undefined);
    };
    window.addEventListener('message', listener);
    return () => { live.current = false; ready.current = false; window.removeEventListener('message', listener); };
  }, [channel]);

  useEffect(() => {
    const win = iframe.current?.contentWindow;
    if (!live.current || !ready.current || !win || signature === sent.current) return;
    sent.current = signature;
    safePost(win, { type: 'michi-component:update', channel, props, data: preview ? { sample: true, value: 12, label: 'Example' } : data });
  }, [channel, data, preview, props, signature]);

  // A new palette or UI font reaches the running component: the shell sets the palette on its root's style, the font on the document's.
  // Those styles also change on every step of a sidebar drag, so the frame looks once per animation frame.
  useEffect(() => {
    const frame = iframe.current;
    if (!frame || typeof MutationObserver === 'undefined') return;
    let request = 0;
    const look = () => {
      request = 0;
      const win = frame.contentWindow;
      if (!live.current || !ready.current || !win) return;
      const theme = sandboxThemeAt(frame);
      const key = JSON.stringify(theme);
      if (key === themeSent.current) return;
      themeSent.current = key;
      safePost(win, { type: 'michi-component:theme', channel, theme });
    };
    const observer = new MutationObserver(() => { if (!request) request = window.requestAnimationFrame(look); });
    for (const target of new Set([document.documentElement, frame.closest('[style*="--term-bg"]')])) {
      if (target) observer.observe(target, { attributes: true, attributeFilter: ['style'] });
    }
    return () => {
      observer.disconnect();
      if (request) window.cancelAnimationFrame(request);
    };
  }, [channel, stopped]);

  return <section className="page-component-frame" aria-label={`${name} component`} data-preview={preview || undefined}>
    {!stopped && <iframe ref={iframe} key={`${mount}:${versionKey ?? ''}:${code}`} src={src} sandbox={COMPONENT_SANDBOX_IFRAME} referrerPolicy="no-referrer" title={`${name} preview`} style={{ height }} onLoad={onLoad} />}
    {stopped && <div className="page-component-error" role="status">Component stopped. Remove it or reload to run it again.</div>}
    {failure && !stopped && <div className="page-component-error" role="alert"><p>{failure}</p><button type="button" onClick={() => setShowCode(value => !value)}>{showCode ? 'Hide code' : 'View code'}</button><button type="button" onClick={() => setFailure(null)}>Dismiss</button><button type="button" onClick={() => { const now = Date.now(); reloads.current = reloads.current.filter(stamp => now - stamp < 15_000); if (reloads.current.length >= 3) { setFailure('Reload is temporarily paused after repeated failures. Disable this component or wait a moment before trying again.'); return; } reloads.current.push(now); loads.current = 0; live.current = false; pending.current = 0; setFailure(null); setMount(value => value + 1); }}>Reload</button><button type="button" onClick={() => onAskDraft?.(`The component “${name}” failed: ${failure}\nPlease help fix it.`)}>Ask assistant to fix</button><button type="button" onClick={() => { live.current = false; pending.current = 0; setStopped(true); onStop?.(); }}>Stop component</button>{showCode && <pre className="page-component-source">{code}</pre>}</div>}
  </section>;
}
