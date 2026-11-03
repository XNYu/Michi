import { createElement, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { toast } from 'sonner';
import { getElectron } from '../lib/electronBridge';

export interface NotifyOptions {
  title: string;
  body?: string;
  onClick?: () => void;
}

/** Show an in-app toast and, when the window is unfocused, an OS notification. */
export function notify({ title, body, onClick }: NotifyOptions): void {
  if (onClick) {
    // sonner 1.7.4 has no whole-toast onClick (only close/cancel/action button
    // callbacks), so click-anywhere-to-navigate has to be a custom toast: an
    // interactive card whose root element owns the click and dismisses itself.
    toast.custom(
      (id) =>
        createElement(
          'div',
          {
            role: 'button',
            tabIndex: 0,
            className: 'app-toast-card',
            onClick: () => { toast.dismiss(id); onClick(); },
            onKeyDown: (e: ReactKeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toast.dismiss(id);
                onClick();
              }
            },
          },
          createElement('div', { className: 'app-toast-card__title' }, title),
          body
            ? createElement('div', { className: 'app-toast-card__body' }, body)
            : null,
        ),
      { duration: 4000 },
    );
  } else {
    toast(title, { description: body, duration: 4000 });
  }

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
