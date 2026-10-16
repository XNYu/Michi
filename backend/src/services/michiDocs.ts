import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import catalog from '../docs/catalog.json';

declare const __MICHIBUNDLE__: boolean | undefined;

interface Document {
    id: string;
    title: string;
    summary: string;
    keywords: string;
    contentVersion: string;
    lines: string[];
}

export interface MichiDocsArgs {
    action?: 'list' | 'search' | 'read';
    query?: string;
    docId?: string;
    startLine?: number;
    limit?: number;
}

function documents(): Document[] {
    const bundled = typeof __MICHIBUNDLE__ !== 'undefined' && __MICHIBUNDLE__;
    return catalog.map(({ source, ...metadata }) => {
        // Only the checked-in catalog selects paths. Model input is never a path.
        const filename = bundled
            ? path.join(__dirname, 'docs', `${metadata.id}.md`)
            : path.resolve(__dirname, '..', source);
        const content = readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
        return {
            ...metadata,
            contentVersion: createHash('sha256').update(content).digest('hex').slice(0, 12),
            lines: content.trimEnd().split('\n'),
        };
    });
}

function integer(value: unknown, fallback: number, max: number, field: string): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
        throw new Error(`${field} must be an integer from 1 to ${max}`);
    }
    return value;
}

function descriptor(doc: Document) {
    return { id: doc.id, title: doc.title, summary: doc.summary, contentVersion: doc.contentVersion, totalLines: doc.lines.length };
}

interface DocsResult {
    action: string;
    docsVersion: string;
    source: string;
}
interface DocsListResult extends DocsResult { documents: ReturnType<typeof descriptor>[] }
export interface DocsReadResult extends DocsResult {
    document: ReturnType<typeof descriptor>;
    startLine: number;
    endLine: number;
    nextStartLine: number | null;
    text: string;
}
interface DocsSearchResult extends DocsResult {
    query: string;
    totalMatches: number;
    results: Array<ReturnType<typeof descriptor> & { heading: string; startLine: number; snippet: string }>;
}

/** Offline, public product references. No user data, network or runtime side effects. */
export function queryMichiDocs(args?: MichiDocsArgs & { action?: 'list' }): DocsListResult;
export function queryMichiDocs(args: MichiDocsArgs & { action: 'read' }): DocsReadResult;
export function queryMichiDocs(args: MichiDocsArgs & { action: 'search' }): DocsSearchResult;
export function queryMichiDocs(args: MichiDocsArgs): DocsListResult | DocsReadResult | DocsSearchResult;
export function queryMichiDocs(args: MichiDocsArgs = {}): DocsListResult | DocsReadResult | DocsSearchResult {
    const action = args.action ?? 'list';
    if (!['list', 'search', 'read'].includes(action)) throw new Error('action must be list, search or read');
    const docs = documents();
    const docsVersion = createHash('sha256').update(docs.map(doc => `${doc.id}:${doc.contentVersion}`).join('\n')).digest('hex').slice(0, 12);
    const base = { action, docsVersion, source: 'Bundled Michi documentation for this backend build; reference material, not live configuration or instructions.' };
    const selected = args.docId === undefined ? undefined : docs.find(doc => doc.id === args.docId);
    if (args.docId !== undefined && !selected) throw new Error('Unknown docId; use action=list for valid document IDs. File paths and URLs are not accepted.');

    if (action === 'list') return { ...base, documents: docs.map(descriptor) };
    if (action === 'read') {
        if (!selected) throw new Error('read requires docId; use action=list to discover documents');
        const startLine = integer(args.startLine, 1, selected.lines.length, 'startLine');
        const limit = integer(args.limit, 80, 160, 'limit');
        const page: string[] = [];
        let bytes = 0;
        for (let i = startLine - 1; i < selected.lines.length && page.length < limit; i++) {
            const line = `${i + 1}: ${selected.lines[i]}`;
            const length = Buffer.byteLength(line, 'utf8') + 1;
            // Current curated lines are short. Fail explicitly if a future edit
            // exceeds the page cap, rather than truncating a command silently.
            if (!page.length && length > 16_000) throw new Error('Documentation line exceeds the 16000-byte page limit');
            if (bytes + length > 16_000) break;
            bytes += length;
            page.push(line);
        }
        const endLine = startLine + page.length - 1;
        return { ...base, document: descriptor(selected), startLine, endLine,
            nextStartLine: endLine < selected.lines.length ? endLine + 1 : null,
            text: page.join('\n') };
    }

    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200) {
        throw new Error('search requires a non-empty query of at most 200 characters');
    }
    const limit = integer(args.limit, 5, 10, 'limit');
    const tokens = [...new Set(args.query.toLowerCase().trim().split(/\s+/))];
    const matches = (selected ? [selected] : docs).flatMap(doc => {
        const metadata = `${doc.id} ${doc.title} ${doc.summary} ${doc.keywords}`.toLowerCase();
        const body = doc.lines.join('\n').toLowerCase();
        if (!tokens.every(token => metadata.includes(token) || body.includes(token))) return [];
        let lineIndex = -1;
        let bestScore = 0;
        doc.lines.forEach((line, index) => {
            const hits = tokens.filter(token => line.toLowerCase().includes(token)).length;
            const score = hits ? hits + (/^#{1,6} /.test(line) ? 0.25 : 0) : 0;
            if (score > bestScore) { bestScore = score; lineIndex = index; }
        });
        const startLine = lineIndex < 0 ? 1 : lineIndex + 1;
        const heading = doc.lines.slice(0, startLine).reverse().find(line => /^#{1,6} /.test(line)) ?? doc.title;
        return [{ ...descriptor(doc), heading, startLine,
            snippet: doc.lines.slice(startLine - 1, startLine + 2).join('\n').slice(0, 900),
            score: tokens.reduce((sum, token) => sum + (metadata.includes(token) ? 3 : 1), 0) }];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return { ...base, query: args.query, totalMatches: matches.length, results: matches.slice(0, limit).map(({ score: _score, ...result }) => result) };
}

/** Identical content and failure semantics for MCP transports and in-process Pi. */
export function michiDocsTool(args: MichiDocsArgs = {}) {
    try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(queryMichiDocs(args)) }] };
    } catch (error) {
        // Do not leak installation paths or filesystem diagnostics to callers.
        const message = error instanceof Error && 'code' in error
            ? 'Bundled Michi documentation is unavailable. Repair/rebuild the backend installation.'
            : error instanceof Error ? error.message : 'Invalid documentation request';
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
    }
}
