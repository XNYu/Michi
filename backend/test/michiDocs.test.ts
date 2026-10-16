import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { queryMichiDocs, michiDocsTool, type DocsReadResult } from '../src/services/michiDocs';
import catalog from '../src/docs/catalog.json';

test('bundled catalog exposes only public product documents, all readable with content versions', () => {
    const index = queryMichiDocs();
    assert.equal(new Set(index.documents!.map(doc => doc.id)).size, catalog.length);
    assert.ok(index.documents!.some(doc => doc.id === 'crew'));
    for (const doc of index.documents!) {
        assert.match(doc.contentVersion, /^[a-f0-9]{12}$/);
        const read = queryMichiDocs({ action: 'read', docId: doc.id });
        assert.equal(read.document!.contentVersion, doc.contentVersion);
        assert.match(read.text!, /^1: # /);
        assert.doesNotMatch(JSON.stringify(read), /\/Users\/yonghuyu\//);
    }
    assert.equal(index.docsVersion, queryMichiDocs().docsVersion);
});

test('search finds setup/approval topics in English and indexed Chinese without regex evaluation', () => {
    for (const query of ['sessionApproval', 'CREW MCP', '审批', '远程']) {
        const found = queryMichiDocs({ action: 'search', query });
        assert.ok(found.results!.length > 0, query);
        assert.ok(found.results!.every(result => result.startLine >= 1 && result.snippet.length <= 900));
    }
    const scoped = queryMichiDocs({ action: 'search', docId: 'crew', query: 'sessionApproval' });
    assert.equal(scoped.results!.length, 1);
    assert.equal(scoped.results![0].id, 'crew');
    assert.equal(queryMichiDocs({ action: 'search', query: 'no-such-topic-987654' }).totalMatches, 0);
    assert.equal(queryMichiDocs({ action: 'search', query: 'sessionApproval|this-never-occurs' }).totalMatches, 0);
    assert.equal(queryMichiDocs({ action: 'search', query: 'Michi', limit: 1 }).results!.length, 1);
});

test('line and byte limited reads paginate through full Crew guide without loss', () => {
    const pages: string[] = [];
    let startLine: number | null = 1;
    while (startLine !== null) {
        const page: DocsReadResult = queryMichiDocs({ action: 'read', docId: 'crew', startLine, limit: 7 });
        assert.equal(page.startLine, startLine);
        assert.ok(Buffer.byteLength(page.text!, 'utf8') <= 16000);
        assert.ok(page.text!.split('\n').length <= 7);
        pages.push(page.text!);
        startLine = page.nextStartLine!;
    }
    const expected = fs.readFileSync(path.join(__dirname, '../src/agents/crew/GETTING_STARTED.md'), 'utf8').replace(/\r\n/g, '\n').trimEnd()
        .split('\n').map((line, index) => `${index + 1}: ${line}`).join('\n');
    assert.equal(pages.join('\n'), expected);
    for (const doc of catalog) {
        const page = queryMichiDocs({ action: 'read', docId: doc.id, limit: 160 });
        assert.ok(Buffer.byteLength(page.text!, 'utf8') <= 16000);
    }
});

test('rejects paths, unknown IDs, missing parameters and unbounded pagination', () => {
    for (const docId of ['../config.json', '/etc/passwd', 'https://example.com', '__proto__', 'no-such-doc']) {
        const result = michiDocsTool({ action: 'read', docId });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Unknown docId/);
    }
    for (const args of [
        { action: 'read' }, { action: 'search' }, { action: 'search', query: ' ' },
        { action: 'search', query: 'a'.repeat(201) }, { action: 'write' },
        ...[0, -1, 1.5, NaN, Infinity, '1'].map(startLine => ({ action: 'read', docId: 'crew', startLine })),
        ...[0, 161, -1, 1.5].map(limit => ({ action: 'read', docId: 'crew', limit })),
        { action: 'search', query: 'crew', limit: 11 },
    ]) assert.equal(michiDocsTool(args as any).isError, true, JSON.stringify(args));
});

test('bundled reader works from a relocated package without source files or cwd assumptions', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-docs-package-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filename = path.join(dir, 'reader.cjs');
    buildSync({ entryPoints: [path.join(__dirname, '../src/services/michiDocs.ts')], outfile: filename,
        bundle: true, platform: 'node', format: 'cjs', define: { __MICHIBUNDLE__: 'true' }, logLevel: 'silent' });
    const probe = 'const r=require(process.argv[1]).michiDocsTool({action:"read",docId:"crew"});process.stdout.write(JSON.stringify(r));';
    const run = () => JSON.parse(execFileSync(process.execPath, ['-e', probe, filename], { cwd: os.tmpdir(), encoding: 'utf8' }));
    const missing = run();
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /documentation is unavailable/);
    assert.ok(!missing.content[0].text.includes(dir));
    fs.mkdirSync(path.join(dir, 'docs'));
    for (const doc of catalog) fs.copyFileSync(path.resolve(__dirname, '../src', doc.source), path.join(dir, 'docs', `${doc.id}.md`));
    const read = run();
    assert.notEqual(read.isError, true);
    assert.match(read.content[0].text, /sessionApproval/);
    assert.deepEqual(JSON.parse(read.content[0].text), queryMichiDocs({ action: 'read', docId: 'crew' }));
});
