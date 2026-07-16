import { useEffect, useRef, useState } from 'react';
import { searchMessages as searchMessagesApi, type SearchResult as ServerRow } from '../services/api';
import type { MessageMatch, SearchResult } from './search';
import type { Project } from './chatTypes';

/**
 * Server-side (SQLite FTS) message search for the command palette / global
 * search. Replaces the old in-memory `searchMessages(nodes, projects, query)`
 * scan, which silently missed any tree whose message bodies were not lazily
 * loaded. The backend FTS index covers every message regardless of what the
 * client has in memory, so results are always complete.
 *
 * Maps the backend `SearchResult` rows to the `MessageMatch` shape the palette
 * already renders. `messageIdx` is -1 (unknown server-side; navigation scrolls
 * by `messageId`, which does not need the index). The `<mark>…</mark>` tags in
 * the backend snippet are parsed into `matchOffsetInSnippet` for highlighting.
 */
export function useServerSearch(
  debouncedQuery: string,
  projects: Project[],
): SearchResult {
  const [result, setResult] = useState<SearchResult>(EMPTY_RESULT);
  // Monotonic request id so a slow earlier response can't overwrite a newer one.
  const reqIdRef = useRef(0);

  const projectNameById = useRef<Map<string, string>>(new Map());
  projectNameById.current = new Map(projects.map((p) => [p.id, p.name]));

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      setResult(EMPTY_RESULT);
      return;
    }
    const reqId = ++reqIdRef.current;
    let cancelled = false;
    (async () => {
      try {
        const { results, total } = await searchMessagesApi(q);
        if (cancelled || reqId !== reqIdRef.current) return;
        const matches = results.map((r) => toMessageMatch(r, projectNameById.current));
        setResult({ matches, truncated: total > matches.length, totalUnbounded: total });
      } catch {
        if (cancelled || reqId !== reqIdRef.current) return;
        setResult(EMPTY_RESULT);
      }
    })();
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  return result;
}

const EMPTY_RESULT: SearchResult = { matches: [], truncated: false, totalUnbounded: 0 };

/** Parse the backend snippet's `<mark>…</mark>` into plain text + match range. */
function parseSnippet(raw: string): { text: string; range: [number, number] } {
  const open = raw.indexOf('<mark>');
  if (open === -1) return { text: raw, range: [0, 0] };
  const afterOpen = raw.slice(0, open) + raw.slice(open + '<mark>'.length);
  const close = afterOpen.indexOf('</mark>');
  if (close === -1) {
    // Malformed: strip the open tag, no highlight.
    return { text: afterOpen, range: [0, 0] };
  }
  const text = afterOpen.slice(0, close) + afterOpen.slice(close + '</mark>'.length);
  return { text, range: [open, close] };
}

function toMessageMatch(r: ServerRow, names: Map<string, string>): MessageMatch {
  const { text, range } = parseSnippet(r.snippet ?? '');
  const workspaceName = r.workspace_name || names.get(r.workspace_id) || '(workspace)';
  return {
    projectId: r.workspace_id,
    projectName: workspaceName,
    workspaceId: r.workspace_id,
    workspaceName,
    nodeId: r.node_id,
    threadName: r.node_title ?? '(untitled)',
    messageIdx: -1,
    messageId: r.id,
    role: r.role === 'assistant' ? 'assistant' : 'user',
    snippet: text,
    matchOffsetInSnippet: range,
  };
}
