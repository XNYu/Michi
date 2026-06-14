import React from 'react';
import { useChatStore } from '../../state/chatStore';
import { usePrefs } from '../../state/prefs';
import { PopoverSurface, MenuItem, Tooltip } from '../ui/Popover';

/**
 * Compact viewport-anchored tooltip used by header icon buttons and the
 * workspace menu trigger. Now a thin alias over the shared `Tooltip`
 * primitive from `ui/Popover` so every floating panel in the app pulls
 * from the same surface tokens. Kept as a named export because Topbar
 * still imports `HeaderTooltip` by name.
 */
export const HeaderTooltip = Tooltip;

export function FolderIcon({ size = 14 }: { size?: number } = {}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 4.5a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5Z" />
    </svg>
  );
}

/** Button that opens a popover listing live workspaces. The popover is
 *  fixed-positioned to the button's viewport rect so it works regardless
 *  of where the button is mounted (full sidebar header or 44px rail). */
export function WorkspaceMenuButton({
  size = 14,
  buttonSize = 26,
}: { size?: number; buttonSize?: number } = {}) {
  const { activeProject, projects, selectProject } = useChatStore();
  const { prefs, setPref } = usePrefs();
  const [open, setOpen] = React.useState(false);
  const [hover, setHover] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = React.useState<{ left: number; top: number } | null>(null);

  const liveProjects = React.useMemo(
    () => projects.filter((p) => !p.deletedAt && !p.archivedAt),
    [projects],
  );

  // Choosing a workspace from the menu should reveal its threads. Force the
  // explicit-expanded flag to true so a previously user-collapsed row opens.
  const pickWorkspace = (id: string) => {
    selectProject(id);
    setOpen(false);
    setPref('sidebarExpanded', {
      ...prefs.sidebarExpanded,
      workspaces: { ...prefs.sidebarExpanded.workspaces, [id]: true },
    });
  };

  // Anchor the popover to the button's viewport rect so it can escape the
  // sidebar's overflow:hidden clip context.
  React.useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setAnchor({ left: r.right + 4, top: r.top });
  }, [open]);

  return (
    <span>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Workspaces"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: buttonSize,
          height: buttonSize,
          background: hover || open ? 'var(--term-hover-bg, var(--term-alt))' : 'transparent',
          border: 'none',
          borderRadius: 6,
          color: hover || open ? 'var(--term-mid)' : 'var(--term-faint)',
          cursor: 'pointer',
          transition: 'background var(--t-quick) var(--t-ease), color var(--t-quick) var(--t-ease)',
          flexShrink: 0,
        }}
      >
        <FolderIcon size={size} />
      </button>
      {hover && !open && <Tooltip anchorRef={btnRef} label="workspace" />}
      {open && anchor && (
        <>
          {/* Click-catcher scrim — keep zIndex just below the popover so the
              popover wins the stacking contest. */}
          <div
            onMouseDown={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <PopoverSurface
            left={anchor.left}
            top={anchor.top}
            minWidth={200}
            maxHeight={320}
            zIndex={41}
            onClick={(e) => e.stopPropagation()}
          >
            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {liveProjects.length === 0 ? (
                <li
                  style={{
                    padding: '8px 10px',
                    fontSize: 11.5,
                    color: 'var(--term-muted)',
                    listStyle: 'none',
                  }}
                >
                  — no workspaces —
                </li>
              ) : (
                liveProjects.map((p) => {
                  const active = p.id === activeProject?.id;
                  return (
                    <MenuItem
                      key={p.id}
                      active={active}
                      onClick={() => pickWorkspace(p.id)}
                    >
                      <span style={{ color: 'var(--term-accent)', width: 10 }}>
                        {active ? '◉' : ' '}
                      </span>
                      <span>{p.name}</span>
                    </MenuItem>
                  );
                })
              )}
              <li
                aria-hidden="true"
                style={{
                  borderTop: '1px solid var(--term-line)',
                  margin: '4px 0 0 0',
                  listStyle: 'none',
                }}
              />
              <MenuItem
                onClick={() => {
                  setOpen(false);
                  window.dispatchEvent(new CustomEvent('michi:open-new-workspace'));
                }}
              >
                <span style={{ color: 'var(--term-accent)', width: 10 }}>+</span>
                <span>new workspace</span>
              </MenuItem>
            </ul>
          </PopoverSurface>
        </>
      )}
    </span>
  );
}
