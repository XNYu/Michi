import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Clock, House, Layers, MessageSquare, Settings, Sparkle } from 'lucide-react';
import { BONE, cssVarsFor } from '../../../tokens';
import { MetaChatArea, useMetaChatWindow, type MetaChatSuggestion } from '..';
import '../../../../../fonts.css';
import '../../../../../index.css';
import './harness.css';

// Fictional projects and progress for the layout harness.
const PAGES = {
  sample: { name: 'Sample notebook', kicker: 'Page · Sample notebook · default home', line: 'The example notebook tracks reading notes and a sample release.' },
  release: { name: 'Sample release', kicker: 'Page · Sample notebook', line: 'The sample release is waiting for a final review.' },
} as const;
type PageId = keyof typeof PAGES;

const SUGGESTIONS: MetaChatSuggestion[] = [
  { id: 'thread', label: 'Start a thread to run the rollback cases' },
  { id: 'top3', label: 'Condense progress into the top 3' },
  { id: 'perf', label: 'Create a “Performance” subpage' },
  { id: 'who', label: 'Who is running the incremental-read cases?' },
];

const PROGRESS = [
  ['Notebook outline reviewed', '01-06 15:00', 'The sample sections now follow the reading order.'],
  ['Import example connected', '01-06 14:00', 'Checking duplicate notes and empty input.'],
  ['Example changes merged', '01-06 12:00', 'The sample checks passed.'],
  ['Reader toolbar prepared', '01-06 11:00', 'A draft is ready for review.'],
  ['Preview refreshed', '01-06 10:00', 'The example page shows the latest draft.'],
  ['Notebook checklist written', '01-06 09:00', 'Three sample tasks are listed.'],
];

function Harness() {
  const chat = useMetaChatWindow();
  const [area, setArea] = useState<'spaces' | 'chats'>('spaces');
  const [page, setPage] = useState<PageId>('sample');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const colors = useMemo(() => cssVarsFor('bone', BONE.accent), []);
  const p = PAGES[page];

  const select = (block: string) => setSelected((s) => (s === block ? null : block));

  return (
    <div className="mh-shell" style={colors}>
      <nav className="mh-rail" aria-label="Areas">
        <button type="button" aria-label="Chats" data-on={area === 'chats' || undefined} onClick={() => setArea('chats')}><MessageSquare size={16} /></button>
        <button type="button" aria-label="Pages" data-on={area === 'spaces' || undefined} onClick={() => setArea('spaces')}><Layers size={16} /></button>
        <button type="button" aria-label="Scheduled"><Clock size={16} /></button>
        <span className="mh-rail__spacer" />
        <button type="button" aria-label="Settings"><Settings size={16} /></button>
      </nav>
      <aside className="mh-side">
        <div className="mh-brand"><span>M</span>Michi</div>
        <div className="mh-row"><House size={14} />Home</div>
        <div className="mh-row"><Layers size={14} />All threads</div>
        <button type="button" className="mh-row" onClick={() => { setArea('spaces'); chat.dock(); }}><Sparkle size={14} />Assistant</button>
        <div className="mh-sec">Pages</div>
        {(Object.keys(PAGES) as PageId[]).map((id) => (
          <button key={id} type="button" className="mh-row mh-row--page" data-on={(area === 'spaces' && page === id) || undefined} onClick={() => { setArea('spaces'); setPage(id); setSelected(null); }}>
            <i className="mh-dot" />{PAGES[id].name}
          </button>
        ))}
        <label className="mh-busy"><input type="checkbox" checked={busy} onChange={(e) => setBusy(e.target.checked)} />Meta agent busy</label>
      </aside>
      <header className="mh-top"><span className="mh-crumb">{area === 'spaces' ? 'PAGES' : 'CHATS'}</span><b>{area === 'spaces' ? p.name : 'New thread'}</b></header>
      <main className="mh-main">
        <MetaChatArea
          controller={chat}
          visible={area === 'spaces'}
          pageName={p.name}
          busy={busy}
          target={selected ? { label: selected } : null}
          onClearTarget={() => setSelected(null)}
          suggestions={SUGGESTIONS}
          onSubmit={() => undefined}
        >
          <div className="mh-page">
            {area === 'chats' ? (
              <div className="mh-doc"><h1>Chats</h1><p className="mh-line">The assistant window belongs to Pages and waits here.</p></div>
            ) : (
              <div className="mh-doc">
                <div className="mh-kick">{p.kicker}</div>
                <h1>{p.name}</h1>
                <p className="mh-line">{p.line}</p>
                <div className="mh-metrics">
                  <div><span>Completed examples</span><b>6</b><small>notes, outlines, previews</small></div>
                  <div><span>Reader toolbar draft</span><b className="acc">2 changes</b><small>not merged</small></div>
                  <div><span>Sample export draft</span><b>1 change</b><small>waiting for review</small></div>
                </div>
                <section className="mh-blk" data-sel={selected === 'Next steps' || undefined} onClick={() => select('Next steps')}>
                  <h2>Next steps</h2>
                  <div className="mh-next"><span className="you">You</span><div>Confirm the rewrite of the risks paragraph in “Sample release”<small>Unblocks the release notes draft</small></div></div>
                  <div className="mh-next"><span>Agent</span><div>Run the rollback and cross-workspace cases for incremental reads<small>Unblocks the merge into dev</small></div></div>
                </section>
                <section className="mh-blk" data-sel={selected === 'Progress' || undefined} onClick={() => select('Progress')}>
                  <h2>Progress</h2>
                  <ol className="mh-tl">
                    {PROGRESS.map(([t, when, d]) => <li key={t}><b>{t}</b> <time>{when}</time><p>{d}</p></li>)}
                  </ol>
                </section>
              </div>
            )}
          </div>
        </MetaChatArea>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
