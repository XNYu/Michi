import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASTER_ICON, generateIcons, staleIcons } from './generate-icons.mjs';
import { decodeIcns, decodeIco, pngSize } from './lib/image.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function matches(file, pattern, toPath) {
  const found = [...read(file).matchAll(pattern)].map((m) => toPath(m[1]));
  assert.ok(found.length > 0, `no icon reference found in ${file}; update this test if the reference moved`);
  return found;
}

function packageIcons() {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value)) {
      if (/icon$/i.test(key) && typeof v === 'string') found.push(v);
      else walk(v);
    }
  };
  walk(JSON.parse(read('package.json')).build);
  assert.ok(found.length > 0, 'no icon in package.json build config');
  return found;
}

const manifest = () => JSON.parse(read('frontend/public/manifest.json'));

test('every icon path the app references exists', () => {
  const referenced = [
    ...packageIcons(),
    ...manifest().icons.map((icon) => `frontend/public/${icon.src}`),
    ...matches('electron/main.ts', /'assets',\s*'icons',\s*'([^']+)'/g, (name) => `assets/icons/${name}`),
    ...(fs.existsSync(path.join(root, 'install.ps1'))
      ? matches('install.ps1', /"assets"\s+"icons"\s+"([^"]+)"/g, (name) => `assets/icons/${name}`)
      : []),
    ...matches('frontend/index.html', /<link rel="icon"[^>]*href="\/([^"]+)"/g, (name) => `frontend/public/${name}`),
  ];
  for (const file of referenced) assert.ok(fs.existsSync(path.join(root, file)), `${file} is referenced but missing`);
});

test('the web manifest lists 192 and 512 px PNG icons with their real sizes', () => {
  const declared = new Set();
  for (const icon of manifest().icons) {
    const { width, height } = pngSize(fs.readFileSync(path.join(root, 'frontend/public', icon.src)));
    assert.equal(icon.type, 'image/png', icon.src);
    assert.equal(icon.sizes, `${width}x${height}`, icon.src);
    declared.add(icon.sizes);
  }
  assert.ok(declared.has('192x192') && declared.has('512x512'), `manifest sizes: ${[...declared].join(', ')}`);
});

test('the macOS icon carries every iconset size', () => {
  const sizes = new Set(decodeIcns(fs.readFileSync(path.join(root, 'assets/icons/icon.icns'))).map(([, img]) => img.width));
  assert.deepEqual([...sizes].sort((a, b) => a - b), [16, 32, 64, 128, 256, 512, 1024]);
});

test('the Windows icon carries the shell sizes from 16 to 256 px', () => {
  const sizes = decodeIco(fs.readFileSync(path.join(root, 'assets/icons/icon.ico'))).map((img) => img.width);
  assert.deepEqual(sizes.sort((a, b) => a - b), [16, 24, 32, 48, 64, 128, 256]);
});

test(`generated icons match ${MASTER_ICON}`, () => {
  assert.deepEqual(staleIcons(root), [], 'run npm run icons:generate and commit the result');
});

test('the icon check reports missing and replaced outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-icons-'));
  try {
    for (const sub of ['assets/icons', 'frontend/public']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    fs.copyFileSync(path.join(root, MASTER_ICON), path.join(dir, MASTER_ICON));
    const written = generateIcons(dir);
    assert.deepEqual(staleIcons(dir), []);
    fs.rmSync(path.join(dir, written[0]));
    fs.copyFileSync(path.join(dir, 'frontend/public/icon-192.png'), path.join(dir, 'frontend/public/favicon.png'));
    assert.deepEqual(staleIcons(dir), [written[0], 'frontend/public/favicon.png']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
