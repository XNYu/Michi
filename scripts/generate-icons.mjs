#!/usr/bin/env node
// Generates every shipped icon from the one master, assets/icons/icon.png
// (1024x1024 RGBA). To change the icon, replace the master and run
//   npm run icons:generate
// then commit the master and the generated files. `--check` regenerates in
// memory and exits 1 if any committed file is missing or no longer matches.
//
// The desktop icons (.icns, .ico) keep the master's transparent margin. The
// web icons are cropped to the master's opaque area, as the browser favicon
// always was.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  decodeIcns, decodeIco, decodePng, encodeIcns, encodeIco, encodePng, opaqueBounds, resizeSquare,
} from './lib/image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MASTER_ICON = 'assets/icons/icon.png';

// Sizes the Windows shell asks for (small icons, taskbar, Explorer views), so
// it never has to scale the 256 px image down on its own. Largest first:
// some tools read only the first entry (app-builder's icon set does).
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

// Same types and sizes iconutil writes for a full .iconset.
const ICNS_ENTRIES = [
  ['ic04', 16], ['ic05', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128],
  ['ic08', 256], ['ic13', 256], ['ic09', 512], ['ic14', 512], ['ic10', 1024],
];

const WEB_PNGS = [
  ['frontend/public/favicon.png', 144],
  ['frontend/public/icon-192.png', 192],
  ['frontend/public/icon-512.png', 512],
];

// Each output: its repo-relative path, the decoder for the committed file,
// and the images it should hold.
function renderOutputs(master) {
  const full = { x: 0, y: 0, width: master.width, height: master.height };
  const web = opaqueBounds(master);
  return [
    {
      file: 'assets/icons/icon.icns',
      images: ICNS_ENTRIES.map(([type, size]) => [type, resizeSquare(master, full, size)]),
      encode: encodeIcns,
      decode: decodeIcns,
    },
    {
      file: 'assets/icons/icon.ico',
      images: ICO_SIZES.map((size) => resizeSquare(master, full, size)),
      encode: encodeIco,
      decode: decodeIco,
    },
    ...WEB_PNGS.map(([file, size]) => ({
      file,
      images: [resizeSquare(master, web, size)],
      encode: ([img]) => encodePng(img),
      decode: (buf) => [decodePng(buf)],
    })),
  ];
}

function readMaster(root) {
  const master = decodePng(fs.readFileSync(path.join(root, MASTER_ICON)));
  if (master.width !== 1024 || master.height !== 1024) {
    throw new Error(`${MASTER_ICON} must be 1024x1024, got ${master.width}x${master.height}`);
  }
  return master;
}

/** Write every generated icon under `root`; returns the repo-relative paths. */
export function generateIcons(root = ROOT) {
  const outputs = renderOutputs(readMaster(root));
  for (const out of outputs) fs.writeFileSync(path.join(root, out.file), out.encode(out.images));
  return outputs.map((out) => out.file);
}

// Pixels match when alpha is within 1 and, for visible pixels, every colour
// channel is within 1 (rounding can differ across Node versions).
function samePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.abs(a.data[i + 3] - b.data[i + 3]) > 1) return false;
    if (a.data[i + 3] === 0 && b.data[i + 3] === 0) continue;
    for (let c = 0; c < 3; c++) if (Math.abs(a.data[i + c] - b.data[i + c]) > 1) return false;
  }
  return true;
}

const unwrap = (entry) => (Array.isArray(entry) ? entry : [null, entry]);

/** Repo-relative paths of generated icons that are missing or stale. */
export function staleIcons(root = ROOT) {
  const stale = [];
  for (const out of renderOutputs(readMaster(root))) {
    const file = path.join(root, out.file);
    if (!fs.existsSync(file)) {
      stale.push(out.file);
      continue;
    }
    const actual = out.decode(fs.readFileSync(file)).map(unwrap);
    const expected = out.images.map(unwrap);
    const same = actual.length === expected.length && expected.every(([type, img], i) =>
      actual[i][0] === type && samePixels(actual[i][1], img));
    if (!same) stale.push(out.file);
  }
  return stale;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--check')) {
    const stale = staleIcons();
    if (stale.length) {
      console.error(`Icons out of date with ${MASTER_ICON}: ${stale.join(', ')}\nRun: npm run icons:generate`);
      process.exit(1);
    }
    console.log('Icons match the master.');
  } else {
    for (const file of generateIcons()) console.log(`wrote ${file}`);
  }
}
