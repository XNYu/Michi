import { Tooltip } from '../ui/Popover';

/**
 * Compact viewport-anchored tooltip used by header icon buttons and the
 * workspace menu trigger. Now a thin alias over the shared `Tooltip`
 * primitive from `ui/Popover` so every floating panel in the app pulls
 * from the same surface tokens. Kept as a named export because Topbar
 * still imports `HeaderTooltip` by name.
 */
export const HeaderTooltip = Tooltip;
