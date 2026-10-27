import React from 'react';
import { BRANCHES_LAYOUT_CSS } from '../../pages/docLayout';
import '../../rail/rail.css';
import './michiPage.css';

/**
 * The document page Michi projects and Spaces share. `sheet`: a paper sheet on
 * a soft field with a sticky card beside it (docLayout.ts). `column`: the
 * borderless centred column of Settings and the Spaces homes
 * (`.area-settings__doc`), with no card beside it. Callers own what goes in
 * the sheet or column, the card and anything that floats over the field.
 */
export function DocumentShell({
  label,
  scrollerRef,
  background,
  className,
  layout = 'sheet',
  columnClassName,
  compact = false,
  busy,
  aside,
  after,
  floating,
  children,
  data,
}: {
  label: string;
  scrollerRef?: React.Ref<HTMLElement>;
  background?: string;
  className?: string;
  layout?: 'sheet' | 'column';
  /** Added to the column (`layout="column"`). */
  columnClassName?: string;
  /** One column, tighter sheet: a page shown in a pane. */
  compact?: boolean;
  busy?: boolean;
  /** The card beside the sheet (an outline). Omitted in compact mode and in the column layout. */
  aside?: React.ReactNode;
  /** Rendered inside the scroller after the layout (menus, batch bars). */
  after?: React.ReactNode;
  /** Rendered over the field, outside the scroller, so it stays put while the page scrolls. */
  floating?: React.ReactNode;
  children: React.ReactNode;
  data?: Record<`data-${string}`, string | undefined>;
}) {
  const column = layout === 'column';
  const main = (
    <main
      ref={scrollerRef as React.Ref<HTMLElement>}
      aria-label={label}
      className={[column ? 'area-settings' : '', 'michi-doc', compact ? 'michi-doc--compact' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', background }}
      {...data}
    >
      {/* The column still styles an outline's rows (`.branches-directory__item`) when a caller shows one inline. */}
      <style>{BRANCHES_LAYOUT_CSS}</style>
      {column ? (
        <div className={['area-settings__doc', columnClassName ?? ''].filter(Boolean).join(' ')} aria-busy={busy || undefined}>
          {children}
        </div>
      ) : (
        <div className="branches-layout">
          {!compact && aside}
          <article className="branches-document" aria-busy={busy || undefined}>
            {children}
          </article>
        </div>
      )}
      {after}
    </main>
  );
  if (!floating) return main;
  return (
    <div className="michi-doc-frame">
      {main}
      {floating}
    </div>
  );
}

/** Caption, title row and meta line at the top of a document sheet. */
export function DocumentHeader({
  id,
  caption,
  title,
  titleActions,
  meta,
  metaEnd,
  children,
}: {
  id?: string;
  caption: React.ReactNode;
  title: React.ReactNode;
  titleActions?: React.ReactNode;
  meta?: React.ReactNode;
  metaEnd?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header id={id} className="michi-doc-header">
      <div className="michi-doc-caption michi-doc-caption--accent">{caption}</div>
      <div className="michi-doc-title-row">
        <h1 className="michi-doc-title">{title}</h1>
        {titleActions}
      </div>
      {(meta || metaEnd) && (
        <div className="michi-doc-meta">
          {meta}
          <span className="michi-doc-meta__spacer" />
          {metaEnd}
        </div>
      )}
      {children}
    </header>
  );
}
