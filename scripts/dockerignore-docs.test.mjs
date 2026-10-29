import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The Docker builder stage runs `npm run backend:build`, which copies every
// help doc listed in backend/src/docs/catalog.json (backend/scripts/build.mjs).
// A catalog source excluded by .dockerignore is missing from the build context
// and fails the image build.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendSrc = resolve(repoRoot, 'backend/src');

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

// Subset of Docker's .dockerignore matching: paths are relative to the context
// root, `*` and `?` stay within one path segment, `**` spans segments, `!`
// re-includes, the last matching rule wins, and a rule that matches a parent
// directory applies to everything below it.
function patternToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      i += 1;
      if (pattern[i + 1] === '/') {
        i += 1;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (ch === '*') {
      source += '[^/]*';
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${source}$`);
}

function parseDockerignore(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      const pattern = (negated ? line.slice(1) : line).trim().replace(/^\/+/, '').replace(/\/+$/, '');
      return { negated, regex: patternToRegExp(pattern) };
    });
}

function isExcluded(rules, path) {
  const segments = path.split('/');
  const candidates = segments.map((_, index) => segments.slice(0, index + 1).join('/'));
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.regex.test(candidate))) excluded = !rule.negated;
  }
  return excluded;
}

const rules = parseDockerignore(readFileSync(resolve(repoRoot, '.dockerignore'), 'utf8'));
const catalog = JSON.parse(readFileSync(resolve(backendSrc, 'docs/catalog.json'), 'utf8'));

test('the matcher applies the repository exclusions', () => {
  assert.equal(isExcluded(rules, 'docs/user-guide.md'), true);
  assert.equal(isExcluded(rules, 'CHANGELOG.md'), true);
  assert.equal(isExcluded(rules, 'frontend/node_modules/react/index.js'), true);
  assert.equal(isExcluded(rules, 'README.md'), false);
  assert.equal(isExcluded(rules, 'frontend/.env.production'), false);
  assert.equal(isExcluded(rules, 'backend/src/docs/help.md'), false);
});

test('every help doc source in the catalog is part of the Docker build context', () => {
  assert.ok(catalog.length > 0);
  for (const doc of catalog) {
    const absolute = resolve(backendSrc, doc.source);
    const contextPath = relative(repoRoot, absolute).split(sep).join('/');
    assert.ok(!contextPath.startsWith('..'), `${doc.id}: ${doc.source} is outside the repository`);
    assert.ok(existsSync(absolute), `${doc.id}: ${contextPath} does not exist`);
    assert.equal(
      isExcluded(rules, contextPath),
      false,
      `${doc.id}: ${contextPath} is excluded by .dockerignore; add a !${contextPath} rule`,
    );
  }
});
