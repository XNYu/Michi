import React from 'react';
import { MoreHorizontal } from 'lucide-react';
import { MichiMenu, type MichiMenuItem } from '../../content/page/MichiMenu';
import { LayoutRulesPopover } from './LayoutRulesPopover';
import { useLayoutRules } from './useLayoutRules';

export interface LayoutRulesMenu {
  /** Rules on the page; 0 until the first read answers. */
  count: number;
  /** The "Layout rules N" entry for a page's ⋯ menu; it opens the list from `anchor`. */
  entry: (anchor: HTMLElement | null) => MichiMenuItem;
  /** The open list, or null. */
  popover: React.ReactNode;
}

/** A page's layout rules as one ⋯ menu entry plus the list it opens. */
export function useLayoutRulesMenu({ pageId, backendConnectionId, readOnly = false }: {
  pageId: string | null;
  backendConnectionId: string;
  readOnly?: boolean;
}): LayoutRulesMenu {
  const state = useLayoutRules(pageId, backendConnectionId);
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);
  const count = state.rules?.length ?? 0;
  const entry = React.useCallback((from: HTMLElement | null): MichiMenuItem => ({
    id: 'layout-rules',
    label: 'Layout preferences',
    count,
    sub: 'Edit how this page is organized',
    disabled: !pageId,
    onSelect: () => {
      if (!from) return;
      state.refresh({ report: true });
      setAnchor(from);
    },
  }), [count, pageId, state]);
  const popover = anchor && pageId ? (
    <LayoutRulesPopover
      anchor={anchor}
      rules={state.rules}
      error={state.error}
      readOnly={readOnly}
      preferences={{ pageId, backendConnectionId }}
      onDelete={(rule) => state.remove(rule.id)}
      onClose={(restore) => {
        const from = anchor;
        setAnchor(null);
        if (restore) from.focus({ preventScroll: true });
      }}
    />
  ) : null;
  return { count, entry, popover };
}

/** The ⋯ button of a home page header, whose menu lists the page's layout rules. */
export function LayoutRulesMenuButton({ pageId, backendConnectionId, readOnly }: {
  pageId: string | null;
  backendConnectionId: string;
  readOnly?: boolean;
}) {
  const menu = useLayoutRulesMenu({ pageId, backendConnectionId, readOnly });
  const [menuAnchor, setMenuAnchor] = React.useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" className="michi-doc-title__open" aria-label="Page actions" aria-haspopup="menu" aria-expanded={Boolean(menuAnchor)}
        disabled={!pageId} onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget)}>
        <MoreHorizontal size={16} strokeWidth={1.6} />
      </button>
      {menuAnchor && (
        <MichiMenu
          anchor={menuAnchor}
          label="Page actions"
          width={232}
          align="end"
          entries={[menu.entry(menuAnchor)]}
          onClose={(restore) => { const anchor = menuAnchor; setMenuAnchor(null); if (restore) anchor.focus({ preventScroll: true }); }}
        />
      )}
      {menu.popover}
    </>
  );
}
