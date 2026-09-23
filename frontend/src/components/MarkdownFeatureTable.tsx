import React, { useEffect, useRef, useState } from 'react';
import { ModalShell } from './ui/ModalShell';

function tableRows(table: HTMLTableElement): string[][] {
  return Array.from(table.rows).map((row) => (
    Array.from(row.cells).map((cell) => cell.textContent?.trim() ?? '')
  ));
}
function escapeMarkdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function tableAsMarkdown(table: HTMLTableElement): string {
  const rows = tableRows(table);
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from(
    { length: width },
    (_, index) => escapeMarkdownCell(row[index] ?? ''),
  ));
  const header = normalized[0];
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

function downloadText(filename: string, text: string, type: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * After content stops mutating for this long (ms), switch from fixed
 * (stable during streaming) to auto (content-aware column widths).
 * A short delay avoids switching prematurely between rapid streaming batches.
 */
const SETTLE_DELAY_MS = 400;

/* ------------------------------------------------------------------ */
/*  TableLightbox — portal-based fullscreen table viewer              */
/* ------------------------------------------------------------------ */

interface TableLightboxProps {
  /** The original <table> element to clone into the lightbox. */
  sourceTable: HTMLTableElement;
  onClose: () => void;
  onCopy: () => void;
  onDownload: () => void;
}

function TableLightbox({ sourceTable, onClose, onCopy, onDownload }: TableLightboxProps) {
  // Escape is captured so TerminalShell's own Escape (clear selection / leave
  // the Digest page) does not also fire in the same keypress.
  return (
    <ModalShell
      open
      onClose={onClose}
      title="Table"
      titleGlyph="▦"
      aria-label="Table fullscreen"
      width={1200}
      maxHeight="84vh"
      captureEscape
      headerTrailing={
        <span className="michi-table-lightbox-controls">
          <button aria-label="Copy table" onClick={onCopy} type="button">copy</button>
          <button aria-label="Download table" onClick={onDownload} type="button">download</button>
        </span>
      }
    >
      <div className="michi-table-lightbox-scroll term-scrollbar">
        <table
          className="michi-table-settled"
          dangerouslySetInnerHTML={{ __html: sourceTable.innerHTML }}
        />
      </div>
    </ModalShell>
  );
}

/* ------------------------------------------------------------------ */
/*  MarkdownFeatureTable — inline table with toolbar + settle logic    */
/* ------------------------------------------------------------------ */

export default function MarkdownFeatureTable({
  children,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  // false = streaming phase (table-layout: fixed, stable columns)
  // true  = settled phase  (table-layout: auto, content-aware columns)
  const [settled, setSettled] = useState(false);
  const settledRef = useRef(false);

  /**
   * Observe the table's subtree for mutations. While content is changing
   * (streaming), the table stays `table-layout: fixed` so column widths
   * don't jump. Once content stops changing for SETTLE_DELAY_MS, flip to
   * `table-layout: auto` so the browser recalculates column widths based
   * on all content — a one-time auto-fit.
   */
  useEffect(() => {
    const table = tableRef.current;
    if (!table || settledRef.current) return;

    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = () => {
      settledRef.current = true;
      setSettled(true);
      observer.disconnect();
    };

    const observer = new MutationObserver(() => {
      // Content changed — reset the settle timer.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, SETTLE_DELAY_MS);
    });

    observer.observe(table, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // If the table is already complete (non-streaming message, hydrated),
    // there may be no mutations at all. Schedule an initial settle.
    settleTimer = setTimeout(settle, SETTLE_DELAY_MS);

    return () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      observer.disconnect();
    };
  }, []);

  const copy = async () => {
    const table = tableRef.current;
    if (!table || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(tableAsMarkdown(table));
  };

  const download = () => {
    const table = tableRef.current;
    if (!table) return;
    downloadText('table.md', tableAsMarkdown(table), 'text/markdown;charset=utf-8');
  };

  return (
    <div className="michi-table-feature" data-michi-table-feature>
      <div className="michi-table-controls" data-michi-table-controls>
        <button aria-label="Copy table" onClick={() => void copy()} type="button">copy</button>
        <button aria-label="Download table" onClick={download} type="button">download</button>
        <button
          aria-label="View table fullscreen"
          onClick={() => setFullscreen(true)}
          type="button"
        >
          fullscreen
        </button>
      </div>
      <div className="michi-table-scroll">
        <table
          {...props}
          ref={tableRef}
          className={settled ? 'michi-table-settled' : undefined}
        >
          {children}
        </table>
      </div>

      {fullscreen && tableRef.current && (
        <TableLightbox
          sourceTable={tableRef.current}
          onClose={() => setFullscreen(false)}
          onCopy={() => void copy()}
          onDownload={download}
        />
      )}
    </div>
  );
}
