import React from 'react';
import { Code } from 'lucide-react';

/** A custom view runs a widget in a sandbox, which Michi does not run yet: the view says it is off. */
export function CustomView() {
  return (
    <div className="michi-db-off" role="status">
      <Code size={16} strokeWidth={1.6} aria-hidden="true" />
      <span className="michi-db-off__title">This view is a widget, and widgets are off</span>
      <button
        type="button"
        className="michi-db-off__link"
        onClick={() => window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'settings' } }))}
      >
        Settings
      </button>
    </div>
  );
}
