import { Tooltip } from '../ui/Popover';

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
