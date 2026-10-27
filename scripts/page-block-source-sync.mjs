#!/usr/bin/env node
// Copies Agent Desk's block code into Michi's native page mirror of it, at one Desk commit.
//
//   node scripts/page-block-source-sync.mjs [<desk commit>] [--desk=<agent-desk checkout>] [--merged]
//
// The mirror (frontend/src/components/terminal/content/page/vendor-blocks) keeps Desk's own paths, so the copied files
// import each other unchanged. manifest.json lists what it holds: `verbatim` files are written from the commit as
// they are; `patched` files carry Michi edits, so for those the script prints Desk's diff since the last sync
// for a person to merge, and the recorded commit moves only once they are merged (--merged). Files the mirror
// holds that are in neither list are Michi's own shims (see README.md).
// Reads committed files only (`git show`), never Desk's working tree.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mirror = join(root, 'frontend/src/components/terminal/content/page/vendor-blocks');
const manifestPath = join(mirror, 'manifest.json');

const args = process.argv.slice(2);
const deskArg = args.find((a) => a.startsWith('--desk='));
const desk = deskArg ? deskArg.slice('--desk='.length).replace(/^~(?=\/)/, homedir()) : join(homedir(), 'agent-desk');
const git = (...a) => execFileSync('git', ['-C', desk, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const target = git('rev-parse', '--short', args.find((a) => !a.startsWith('--')) ?? 'HEAD').trim();
const previous = manifest.commit;

for (const path of manifest.verbatim) {
  const out = join(mirror, path);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, git('show', `${target}:${path}`));
}
console.log(`Wrote ${manifest.verbatim.length} verbatim files from Desk ${target}.`);

let pending = 0;
if (previous && previous !== target) {
  for (const path of manifest.patched) {
    const diff = git('diff', `${previous}..${target}`, '--', path);
    if (diff.trim()) { pending += 1; console.log(`\n── ${path} changed in Desk since ${previous}; merge by hand:\n${diff}`); }
  }
  const touched = git('diff', '--name-only', `${previous}..${target}`, '--', 'shared', 'src/desk').trim().split('\n').filter(Boolean);
  const known = new Set([...manifest.verbatim, ...manifest.patched]);
  const other = touched.filter((p) => !known.has(p) && !/\.test\.tsx?$/.test(p));
  if (other.length) console.log(`\nAlso changed in Desk (not mirrored; check whether a shim or the block menu needs it):\n  ${other.join('\n  ')}`);
}

// A patched file whose Desk diff is not merged yet keeps the old commit, so the next run shows that diff again.
if (pending && !args.includes('--merged')) {
  console.log(`\n${pending} patched file(s) to merge. manifest.json still records Desk ${previous}; once merged, run again with --merged.`);
} else {
  manifest.commit = target;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nmanifest.json now records Desk ${target}. Review with: git diff -- ${mirror.slice(root.length + 1)}`);
}
