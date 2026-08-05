import React, { useRef, useState } from 'react';

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

export default function MarkdownFeatureTable({
  children,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

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
    <div
      className={fullscreen ? 'michi-table-feature is-fullscreen' : 'michi-table-feature'}
      data-michi-table-feature
    >
      <div className="michi-table-controls" data-michi-table-controls>
        <button aria-label="Copy table" onClick={() => void copy()} type="button">copy</button>
        <button aria-label="Download table" onClick={download} type="button">download</button>
        <button
          aria-label={fullscreen ? 'Exit table fullscreen' : 'View table fullscreen'}
          onClick={() => setFullscreen((current) => !current)}
          type="button"
        >
          fullscreen
        </button>
      </div>
      <div className="michi-table-scroll">
        <table {...props} ref={tableRef}>{children}</table>
      </div>
    </div>
  );
}
