import React, { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pageViewActionFromHref, pageViewIndex, parsePageViewAction, type PageDto, type PageViewAction, type PageViewPresentation } from 'michi-shared';
import { MarkdownLinkRendererContext } from '../../../markdownLinkRenderer';
import { DrawerShell } from '../../../ui/DrawerShell';
import { ModalShell } from '../../../ui/ModalShell';
import './pageViews.css';

interface Session { presentation: PageViewPresentation; stack: string[]; origin: string; trigger: HTMLElement; outlet: HTMLElement | null }
interface ViewContext {
  open(action: PageViewAction, origin: string, trigger: HTMLElement): void;
  has(viewId: string): boolean;
  origin?: string;
  contentId: string;
}
const Context = createContext<ViewContext | null>(null);

/** The same action serves text, metric values and an entry attached to any content block. */
export function PageViewEntry({ action: raw, children, className = '' }: { action: unknown; children: React.ReactNode; className?: string }) {
  const host = useContext(Context), origin = useId(), action = parsePageViewAction(raw);
  if (!action) return <>{children}</>;
  const available = !!host?.has(action.viewId);
  return <a className={`page-view-entry ${className}`} href={`#view/${action.viewId}`} aria-disabled={!available || undefined}
    title={available ? undefined : 'This view is unavailable on this page'}
    aria-expanded={host?.origin === origin ? true : undefined} aria-controls={host?.origin === origin ? host.contentId : undefined}
    aria-haspopup={(action.presentation ?? 'drawer') === 'inline' ? undefined : 'dialog'}
    onClick={event => { event.preventDefault(); event.stopPropagation(); if (available) host!.open(action, origin, event.currentTarget); }}>
    {children}{!available && <span className="sr-only"> (view unavailable)</span>}
  </a>;
}

/** One host per document identity; portals keep the page's theme, resources and interaction context. */
export function PageViewHost({ page, children, renderBlocks }: { page: PageDto; children: React.ReactNode; renderBlocks(ids: string[]): React.ReactNode }) {
  const views = useMemo(() => pageViewIndex(page.blocks), [page.blocks]);
  const [session, setSession] = useState<Session | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const returnTargets = useRef(new Map<string, HTMLElement>());
  const navigating = useRef(false);
  const activeId = session?.stack[session.stack.length - 1];
  const contentId = useId(), previousLinks = useContext(MarkdownLinkRendererContext);
  const open = useCallback((action: PageViewAction, origin: string, trigger: HTMLElement) => {
    if (!views.has(action.viewId)) return;
    // Navigation inside a view reuses this host, never stacks dialogs.
    if (session && activeId && trigger.closest('[data-page-view-content]')) {
      if (activeId === action.viewId) return;
      positions.current.set(activeId, contentRef.current?.scrollTop ?? 0);
      returnTargets.current.set(activeId, trigger);
      navigating.current = true;
      const at = session.stack.indexOf(action.viewId);
      setSession({ ...session, stack: at >= 0 ? session.stack.slice(0, at + 1) : [...session.stack.slice(-9), action.viewId] });
      return;
    }
    positions.current.clear();
    returnTargets.current.clear();
    const root = trigger.closest('[data-native-page]');
    const frame = root && Array.from(root.children).find(element => element.contains(trigger));
    setSession({ presentation: action.presentation ?? 'drawer', stack: [action.viewId], origin, trigger,
      outlet: frame?.querySelector<HTMLElement>(':scope > [data-page-view-outlet]') ?? null });
  }, [views, session, activeId]);
  useLayoutEffect(() => {
    if (!activeId || !contentRef.current) return;
    contentRef.current.scrollTop = positions.current.get(activeId) ?? 0;
    if (navigating.current) {
      const target = returnTargets.current.get(activeId);
      (target?.isConnected && !target.closest('[hidden]') ? target : contentRef.current).focus({ preventScroll: true });
      navigating.current = false;
    }
  }, [activeId, session?.origin]);
  const close = useCallback(() => {
    if (session?.presentation === 'inline' && session.trigger.isConnected) session.trigger.focus({ preventScroll: true });
    setSession(null);
  }, [session]);
  const context = useMemo<ViewContext>(() => ({ open, has: id => views.has(id), origin: session?.origin, contentId }), [open, views, session?.origin, contentId]);
  const links = useMemo(() => ({
    protocols: previousLinks?.protocols ?? [],
    matches: (href: string) => href.startsWith('#view/') || !!previousLinks?.matches(href),
    render: (href: string, content: React.ReactNode) => {
      if (!href.startsWith('#view/')) return previousLinks?.render(href, content);
      const action = pageViewActionFromHref(href);
      return action ? <PageViewEntry action={action}>{content}</PageViewEntry> : <span title="Invalid view link">{content} <span className="sr-only">(view unavailable)</span></span>;
    },
  }), [previousLinks]);
  const current = session ? views.get(session.stack[session.stack.length - 1]) : undefined;
  const back = session && session.stack.length > 1 ? <button type="button" className="page-view-back" onClick={() => {
    navigating.current = true;
    setSession({ ...session, stack: session.stack.slice(0, -1) });
  }}>Back</button> : null;
  const content = session && <div ref={contentRef} tabIndex={-1} className="page-view-content" id={contentId} data-page-view-content="">
    {session.stack.map((id, index) => {
      const view = views.get(id);
      return <div key={id} hidden={index !== session.stack.length - 1} className="page-view-content__page">
        {view ? renderBlocks(view.blockIds) : <p role="status">This view is no longer available.</p>}
      </div>;
    })}
  </div>;
  const title = current?.title ?? 'View unavailable';
  const inline = session?.presentation === 'inline' && <section className="page-view-inline" aria-label={title}>
    <header><h3>{title}</h3><div>{back}<button type="button" className="page-view-back" onClick={close}>Close details</button></div></header>{content}
  </section>;
  return <Context.Provider value={context}><MarkdownLinkRendererContext.Provider value={links}>
    {children}
    {session?.presentation === 'inline' && (session.outlet?.isConnected ? createPortal(inline, session.outlet) : inline)}
    <DrawerShell open={session?.presentation === 'drawer'} modal={false} title={title} aria-label={title} width={640} onClose={close} headerActions={back}>{session?.presentation === 'drawer' && content}</DrawerShell>
    <ModalShell open={session?.presentation === 'modal'} title={title} aria-label={title} width={760} maxHeight="85vh" onClose={close} headerTrailing={back}>{session?.presentation === 'modal' && content}</ModalShell>
  </MarkdownLinkRendererContext.Provider></Context.Provider>;
}
