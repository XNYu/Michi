import { useMemo } from 'react';

const URL_RE = /https?:\/\/[^\s<>()'"]+/g;
const WWW_RE = /(?<![/@\w.-])www\.[^\s<>()'"]+/g;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

function linkifyLine(line: string): React.ReactNode {
  const matches: { start: number; end: number; url: string; href: string }[] = [];

  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(line)) !== null) {
    let url = m[0];
    const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
    if (trailing) url = url.slice(0, url.length - trailing.length);
    matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: url });
  }

  WWW_RE.lastIndex = 0;
  while ((m = WWW_RE.exec(line)) !== null) {
    let url = m[0];
    const trailing = TRAILING_PUNCT_RE.exec(url)?.[0] ?? '';
    if (trailing) url = url.slice(0, url.length - trailing.length);
    matches.push({ start: m.index, end: m.index + url.length + trailing.length, url, href: `https://${url}` });
  }

  if (!matches.length) return line;
  matches.sort((a, b) => a.start - b.start);
  const deduped: typeof matches = [];
  for (const entry of matches) {
    const prev = deduped[deduped.length - 1];
    if (prev && entry.start < prev.start + prev.url.length) continue;
    deduped.push(entry);
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const { start, end, url, href } of deduped) {
    if (start > lastIndex) parts.push(line.slice(lastIndex, start));
    parts.push(
      <a key={start} href={href} target="_blank" rel="noopener noreferrer">
        {url}
      </a>,
    );
    const trailing = line.slice(start + url.length, end);
    if (trailing) parts.push(trailing);
    lastIndex = end;
  }
  if (lastIndex < line.length) parts.push(line.slice(lastIndex));
  return parts;
}

export default function CodeBlockPlainLines({
  source,
  tail,
}: {
  source: string;
  tail?: React.ReactNode;
}) {
  const lines = useMemo(() => source.split('\n'), [source]);
  return (
    <>
      {lines.map((line, index) => (
        <span className="michi-code-line" key={index}>
          {linkifyLine(line)}
          {index === lines.length - 1 ? tail : null}
        </span>
      ))}
    </>
  );
}
