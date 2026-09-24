import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  codex: { type: 'string', default: 'codex' },
  version: { type: 'string' },
  out: { type: 'string' },
  check: { type: 'boolean', default: false },
} });
const defaultOut = resolve(dirname(fileURLToPath(import.meta.url)), '../test/contracts/codex/baseline');
const out = resolve(values.out ?? defaultOut);
const existing = values.check ? JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) : null;
const expectedVersion = values.version ?? existing?.cliVersion;
if (!expectedVersion) throw new Error('Pass --version explicitly when updating a baseline.');
const version = execFileSync(values.codex, ['--version'], { encoding: 'utf8' }).trim();
if (version !== `codex-cli ${expectedVersion}`) throw new Error(`Expected codex-cli ${expectedVersion}; found ${version}`);
const temp = mkdtempSync(join(tmpdir(), 'michi-codex-schema-'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
try {
  for (const [command, folder] of [['generate-ts', 'ts'], ['generate-json-schema', 'json']]) {
    execFileSync(values.codex, ['app-server', command, '--experimental', '--out', join(temp, folder)], { stdio: 'pipe' });
  }
  // Preserve official bytes, including comments and definitions. The three TS
  // roots are reference snapshots; their discriminants are parsed with the TS AST.
  const sources = {
    'protocol.schema.json': 'json/codex_app_server_protocol.schemas.json',
    'ServerNotification.ts.txt': 'ts/ServerNotification.ts',
    'ServerRequest.ts.txt': 'ts/ServerRequest.ts',
    'ThreadItem.ts.txt': 'ts/v2/ThreadItem.ts',
  };
  const files = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, readFileSync(join(temp, source))]));
  const manifest = {
    cliVersion: expectedVersion,
    experimental: true,
    initializeCapabilities: { experimentalApi: true },
    source: 'https://learn.chatgpt.com/docs/app-server',
    commands: ['codex app-server generate-ts --experimental --out <ts>', 'codex app-server generate-json-schema --experimental --out <json>'],
    sha256: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha256(data)])),
  };
  if (values.check) {
    for (const [name, data] of Object.entries(files)) {
      if (sha256(data) !== existing.sha256[name] || !data.equals(readFileSync(join(out, name)))) {
        throw new Error(`Official schema drift: ${name}. Review a candidate baseline; do not update snapshots blindly.`);
      }
    }
    console.log(`Codex ${expectedVersion}: baseline matches freshly generated official schema.`);
  } else {
    mkdirSync(out, { recursive: true });
    for (const [name, data] of Object.entries(files)) writeFileSync(join(out, name), data);
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`Wrote Codex ${expectedVersion} baseline to ${out}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
