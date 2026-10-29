import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// src/vite-env.d.ts is the one list of VITE_* variables. vite/client's index
// signature lets an undeclared variable type-check, so this test keeps the
// declarations, the source that reads them and .env.example in step. Plain JS
// with node:fs, like the CSS tests: frontend types exclude Node, and Vite
// refuses to serve .env files.
const frontend = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(frontend, path), 'utf8');
const names = (text) => [...new Set(text.match(/\bVITE_[A-Z0-9_]+/g) ?? [])].sort();

function sourceFiles(dir) {
  return readdirSync(join(frontend, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('VITE_* variable list', () => {
  const declared = names(read('src/vite-env.d.ts'));

  it('declares every variable the frontend source reads', () => {
    expect(names(sourceFiles('src').map(read).join('\n'))).toEqual(declared);
  });

  it('documents every declared variable in .env.example', () => {
    expect(names(read('.env.example'))).toEqual(declared);
  });
});
