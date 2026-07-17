import { toast } from 'sonner';
import { getElectron } from '../lib/electronBridge';

export interface NotifyOptions {
  title: string;
  body?: string;
  onClick?: () => void;
}

/** Show an in-app toast and, when the window is unfocused, an OS notification. */
export function notify({ title, body, onClick }: NotifyOptions): void {
  // Always show in-app toast
  toast(title, {
    description: body,
    action: onClick ? { label: 'View', onClick } : undefined,
  });

  // OS notification only when app is NOT focused
  if (!document.hasFocus()) {
    const electron = getElectron();
    if (electron?.showNotification) {
      electron.showNotification(title, body ?? '');
    } else if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body: body ?? '' });
      if (onClick) {
        n.onclick = () => { window.focus(); onClick(); };
      }
    }
  }
}
