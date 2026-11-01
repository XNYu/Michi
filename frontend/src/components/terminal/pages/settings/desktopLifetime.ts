import type { DesktopLifetimeStatus } from '../../../../lib/electronBridge';

/** Hide Mac/Linux/browser rows; keep Windows unsupported reasons visible. */
export function shouldShowLifetimeRows(
  available: boolean,
  phone: boolean,
  status: DesktopLifetimeStatus | null,
): boolean {
  if (!available || phone) return false;
  if (!status) return true;
  return status.supported || !!status.reason?.includes('installed Windows app');
}
