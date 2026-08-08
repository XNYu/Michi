import React, { useEffect, useMemo, useState } from 'react';

let mermaidInitialized = false;
let mermaidRenderSequence = 0;

function downloadText(filename: string, text: string, type: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
export default function MarkdownMermaidBlock({ chart }: { chart: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const normalizedChart = useMemo(() => chart.trim(), [chart]);

  useEffect(() => {
    let active = true;
    setSvg('');
    setError('');
    if (!normalizedChart) return () => { active = false; };

    void import('mermaid').then(async ({ default: mermaid }) => {
      if (!mermaidInitialized) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
        mermaidInitialized = true;
      }
      const id = `michi-mermaid-${mermaidRenderSequence += 1}`;
      try {
        const result = await mermaid.render(id, normalizedChart);
        if (active) setSvg(result.svg);
      } catch (nextError) {
        if (active) setError(nextError instanceof Error ? nextError.message : 'Mermaid render failed');
      }
    });

    return () => {
      active = false;
    };
  }, [normalizedChart]);

  const copy = async () => {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(normalizedChart);
  };

  return (
    <div
      className={fullscreen ? 'michi-mermaid-block is-fullscreen' : 'michi-mermaid-block'}
      data-michi-mermaid
    >
      <div className="michi-mermaid-controls">
        <button aria-label="Copy diagram" onClick={() => void copy()} type="button">copy</button>
        <button
          aria-label="Download diagram"
          onClick={() => downloadText('diagram.svg', svg || normalizedChart, svg ? 'image/svg+xml' : 'text/plain')}
          type="button"
        >
          download
        </button>
        <button
          aria-label={fullscreen ? 'Exit diagram fullscreen' : 'View diagram fullscreen'}
          onClick={() => setFullscreen((current) => !current)}
          type="button"
        >
          fullscreen
        </button>
        <button aria-label="Zoom diagram in" onClick={() => setZoom((value) => Math.min(3, value + 0.25))} type="button">+</button>
        <button aria-label="Zoom diagram out" onClick={() => setZoom((value) => Math.max(0.5, value - 0.25))} type="button">−</button>
      </div>
      <div className="michi-mermaid-viewport">
        {svg ? (
          <div
            aria-label="Mermaid chart"
            className="michi-mermaid-svg"
            dangerouslySetInnerHTML={{ __html: svg }}
            role="img"
            style={{ transform: `scale(${zoom})` }}
          />
        ) : error ? (
          <pre className="michi-mermaid-error">{error}{'\n'}{normalizedChart}</pre>
        ) : (
          <span className="michi-mermaid-loading">Rendering diagram…</span>
        )}
      </div>
    </div>
  );
}
