import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { installApp } from './install-app.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(resolve(repoRoot, file), 'utf8');

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'michi-install-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'build/michi.app');
  mkdirSync(join(src, 'Contents'), { recursive: true });
  writeFileSync(join(src, 'Contents/version'), 'new\n');
  const dstDir = join(dir, 'Applications');
  const calls = [];
  const options = { src, dstDir, quit: () => calls.push('quit'), register: (dst) => calls.push(`register ${dst}`) };
  return { src, dstDir, dst: join(dstDir, 'michi.app'), calls, options };
}

function setMtime(file, seconds) {
  utimesSync(file, seconds, seconds);
}

test('installs the bundle after quitting the running app', (t) => {
  const { dst, calls, options } = fixture(t);
  assert.equal(installApp(options), 'installed');
  assert.equal(readFileSync(join(dst, 'Contents/version'), 'utf8'), 'new\n');
  assert.deepEqual(calls, ['quit', `register ${dst}`]);
});

test('replaces an installed bundle instead of merging into it', (t) => {
  const { dst, options } = fixture(t);
  mkdirSync(join(dst, 'Contents'), { recursive: true });
  writeFileSync(join(dst, 'Contents/stale'), 'old\n');
  installApp(options);
  assert.equal(existsSync(join(dst, 'Contents/stale')), false);
});

test('--if-newer leaves a bundle that is not older than the build', (t) => {
  const { src, dst, calls, options } = fixture(t);
  mkdirSync(join(dst, 'Contents'), { recursive: true });
  writeFileSync(join(dst, 'Contents/version'), 'installed\n');
  setMtime(src, 1_000);
  setMtime(dst, 2_000);
  assert.equal(installApp({ ...options, ifNewer: true }), 'current');
  assert.equal(readFileSync(join(dst, 'Contents/version'), 'utf8'), 'installed\n');
  assert.deepEqual(calls, []);

  setMtime(src, 3_000);
  assert.equal(installApp({ ...options, ifNewer: true }), 'installed');
  assert.equal(readFileSync(join(dst, 'Contents/version'), 'utf8'), 'new\n');
});

test('--if-newer installs when nothing is installed yet', (t) => {
  const { dst, options } = fixture(t);
  assert.equal(installApp({ ...options, ifNewer: true }), 'installed');
  assert.ok(existsSync(dst));
});

test('a missing build fails without touching the installed bundle', (t) => {
  const { src, dst, calls, options } = fixture(t);
  rmSync(src, { recursive: true });
  mkdirSync(dst, { recursive: true });
  assert.throws(() => installApp(options), /built app not found/);
  assert.ok(existsSync(dst));
  assert.deepEqual(calls, []);
});

// install.sh and `michi update` build with `npm run electron:build`, whose
// postelectron:build hook already installs the bundle.
test('only scripts/install-app.mjs copies the bundle into ~/Applications', () => {
  assert.equal(JSON.parse(read('package.json')).scripts['postelectron:build'], 'node scripts/install-app.mjs');
  for (const file of ['install.sh', 'bin/michi']) {
    const text = read(file);
    assert.doesNotMatch(text, /cp -R[^\n]*\.app/, `${file} copies the bundle itself`);
    assert.doesNotMatch(text, /rm -rf[^\n]*(?:APP_DST|\bdst\b)/, `${file} removes the installed bundle itself`);
  }
  assert.match(read('bin/michi'), /^\s*node "\$INSTALL_DIR\/scripts\/install-app\.mjs" --if-newer$/m);
});

test('install.sh does not install the bundle again after electron:build', () => {
  const text = read('install.sh');
  const commands = text.slice(text.indexOf('npm run electron:build'))
    .split('\n')
    .filter((line) => !/^\s*(?:#|info |ok |warn )/.test(line))
    .join('\n');
  assert.doesNotMatch(commands, /install-app\.mjs|electron:install|osascript|mdimport|xattr/);
});

test('michi update does not install the bundle again after electron:build', () => {
  const text = read('bin/michi');
  const update = text.slice(text.indexOf('\n  update)\n')).split('\n    ;;')[0];
  const afterBuild = update.slice(update.indexOf('npm run electron:build'));
  assert.doesNotMatch(afterBuild, /sync_app_bundle|install-app\.mjs/);
});
