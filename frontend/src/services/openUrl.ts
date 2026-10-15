import { getElectron } from '../lib/electronBridge';

export function webUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

/** Explicit external actions bypass the preference, without re-entering window.open routing. */
export function openExternalUrl(value: string): void {
  const url = webUrl(value);
  if (!url) return;
  const electron = getElectron();
  if (electron?.openExternal) electron.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

/** Programmatic app links and agent requests use the same mounted shell handler. */
export function openPreferredUrl(url: string): void {
  const event = new CustomEvent('michi:open-url', { detail: { url }, cancelable: true });
  if (window.dispatchEvent(event)) openExternalUrl(url);
}
