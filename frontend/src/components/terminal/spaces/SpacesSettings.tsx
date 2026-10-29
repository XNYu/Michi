import { Suspense, useState } from 'react';
import { deferredComponent } from '../../deferredComponent';
import './spaceSettings.css';

const MetaAgentSettings = deferredComponent<object>(() => import('../settings/metaAgent/MetaAgentSettings').then(module => ({ default: module.MetaAgentSettings })), <p role="status">Loading Meta agent settings…</p>);
const ComponentsSettings = deferredComponent<object>(() => import('./components/ComponentsSettings').then(module => ({ default: module.ComponentsSettings })), <p role="status">Loading components…</p>);

/** Spaces' own settings stay in its main area, beside its navigation and assistant. */
export function SpacesSettings({ onBack }: { onBack(): void }) {
  const [components, setComponents] = useState(false);
  return <main className="area-settings michi-doc spaces-home term-scrollbar" aria-label="Pages settings">
    <div className="area-settings__doc spaces-home__doc space-settings">
      <button type="button" className="space-settings__back" onClick={components ? () => setComponents(false) : onBack}>← {components ? 'Back to settings' : 'Back to Pages'}</button>
      <h1 className="spaces-home__title">{components ? 'Components' : 'Pages settings'}</h1>
      {components ? <Suspense fallback={<p role="status">Loading components…</p>}><ComponentsSettings /></Suspense> : <>
        <Suspense fallback={<p role="status">Loading Meta agent settings…</p>}><MetaAgentSettings /></Suspense>
        <section className="space-settings__section space-settings__row"><div><h2>Components</h2><p>Browse built-in blocks and manage reusable workspace components.</p></div><button type="button" onClick={() => setComponents(true)}>Browse components</button></section>
      </>}
    </div>
  </main>;
}
