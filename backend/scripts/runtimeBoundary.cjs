'use strict';
// Runtime package boundary ratchet.
//
// The runtime layer (adapters plus the shared AgentRuntime/AgentSession plumbing)
// is being extracted into a reusable package. This scanner records three kinds of
// coupling and compares them with the reviewed fixture in
// backend/test/fixtures/runtimeBoundary/, so coupling can shrink but not grow:
//
//   imports      <from>\t<to>             candidate file -> non-candidate repo module
//   env          <file>\t<NAME|*>         process.env reads in candidate files
//   runtime-ids  <file>\t<id>\t<count>    runtime-id literal comparisons outside adapters
//
// Each file is parsed on its own with ts.createSourceFile (no Program, no type
// checking), so a full scan stays well under a few seconds.
//
// CLI (from the repository root):
//   node backend/scripts/runtimeBoundary.cjs              check; exit 1 on new entries
//   node backend/scripts/runtimeBoundary.cjs --write      rewrite the baseline files
//   node backend/scripts/runtimeBoundary.cjs --ref <ref>  print the scan of a git ref

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { builtinModules } = require('node:module');
const ts = require('typescript');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'backend', 'test', 'fixtures', 'runtimeBoundary');

/**
 * Files whose outgoing dependencies are checked. Later extraction steps extend
 * this list. Entries starting with `!` exclude matches. Supported syntax:
 * `*`, `**`, `?` and flat `{a,b}` alternation.
 */
const CANDIDATE_GLOBS = [
  'backend/src/agents/workflows/**/*.ts',
  'backend/src/agents/{registry,sessionRegistry,sessionStateFeed,chatApprovalState}.ts',
  // Directory-index shims left at the old paths of modules moved into runtime/src/.
  'backend/src/agents/{asyncGate,processTree,executableLookup,runtimeLifecycle,types,attachments,runtimeModelCache,runtimeModelRefresh,modelReasoning,eventQueue,runtimeModelCatalog,sessionAcquisition}/index.ts',
  'backend/src/services/chatEvents/index.ts',
  'backend/src/agents/runs/runMcpSlot/index.ts',
  // The extracted package itself; any import from it into backend/ counts as an edge.
  'runtime/src/**/*.ts',
  // Reserved for generated Codex protocol types; no generated files are checked in.
  '!runtime/src/adapters/codex/gen/**',
  '!**/*.test.ts',
];

/**
 * Files checked for runtime-id literal comparisons. Each runtime's own adapter
 * directory may branch on its id; the shared ACP core (runtime/src/adapters/acp/)
 * belongs to no runtime, so it is checked like the rest of the package. A new
 * adapter directory is added to the exemption by name.
 */
const RUNTIME_ID_GLOBS = [
  'backend/src/**/*.ts',
  'runtime/src/**/*.ts',
  '!backend/src/agents/pi/**',
  '!runtime/src/adapters/{claude,codex,crew,kiro,antigravity}/**',
  '!**/*.test.ts',
];

/** Import edges from this prefix into backend/ always count, even into candidate files. */
const RUNTIME_PACKAGE_PREFIX = 'runtime/';

const RUNTIME_IDS = new Set(['kiro', 'crew', 'claude', 'codex', 'pi', 'antigravity']);
const RUNTIME_ID_TEXT = /(['"`])(?:kiro|crew|claude|codex|pi|antigravity)\1/;
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const RESOLVE_SUFFIXES = ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.json', '/index.ts'];
// TypeScript-style specifiers such as './x.js' that name './x.ts'.
const SOURCE_EXTENSION_FOR = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' };
const BUILTIN_MODULES = new Set(builtinModules);

const KINDS = [
  { key: 'imports', file: 'imports', label: 'import edges', columns: 2,
    describe: '<from>\\t<to>: a runtime-layer file importing a non-runtime repo module' },
  { key: 'env', file: 'env', label: 'process.env reads', columns: 2,
    describe: '<file>\\t<NAME>: a process.env read in a runtime-layer file (* = whole object or dynamic key)' },
  { key: 'runtimeIds', file: 'runtime-ids', label: 'runtime-id comparisons', columns: 3,
    describe: '<file>\\t<id>\\t<count>: runtime-id literal comparisons/case labels outside adapter directories' },
];

const REMEDIATION = [
  'Inject the dependency through a runtime port or option instead of importing app code',
  'or reading process.env in the runtime layer; express runtime differences as runtime',
  'capabilities/options instead of comparing runtime ids outside the adapter directories.',
  'If an entry is truly unavoidable, add it to backend/test/fixtures/runtimeBoundary/',
  'and give the reason in the commit message.',
].join('\n');

// ---------------------------------------------------------------------------
// Globs

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          source += '(?:[^/]+/)*';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) throw new Error(`Unclosed { in glob: ${glob}`);
      source += `(?:${glob.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`;
      i = end;
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function createMatcher(globs) {
  const include = globs.filter((glob) => !glob.startsWith('!')).map(globToRegExp);
  const exclude = globs.filter((glob) => glob.startsWith('!')).map((glob) => globToRegExp(glob.slice(1)));
  return (file) => include.some((re) => re.test(file)) && !exclude.some((re) => re.test(file));
}

/** Directory prefix before the first glob segment, e.g. 'backend/src/agents'. */
function staticPrefix(glob) {
  const segments = [];
  for (const segment of glob.split('/')) {
    if (/[*?{]/.test(segment)) break;
    segments.push(segment);
  }
  if (segments.length === glob.split('/').length) segments.pop(); // literal file path
  return segments.join('/');
}

function scanRoots(globs) {
  const prefixes = [...new Set(globs.filter((glob) => !glob.startsWith('!')).map(staticPrefix))].sort();
  return prefixes.filter((prefix) => !prefixes.some((other) => other !== prefix && (other === '' || prefix.startsWith(`${other}/`))));
}

// ---------------------------------------------------------------------------
// File sources: working tree or a git ref

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function fsSource(repoRoot) {
  const fileCache = new Map();
  return {
    list(root) {
      const out = [];
      const walk = (relativeDir) => {
        let entries;
        try {
          entries = fs.readdirSync(path.join(repoRoot, relativeDir), { withFileTypes: true });
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return;
          throw error;
        }
        for (const entry of entries) {
          const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name !== 'node_modules') walk(relative);
          } else if (entry.isFile()) {
            out.push(relative);
          }
        }
      };
      walk(root);
      return out;
    },
    isFile(relative) {
      if (!fileCache.has(relative)) {
        let isFile = false;
        try { isFile = fs.statSync(path.join(repoRoot, relative)).isFile(); } catch { /* missing */ }
        fileCache.set(relative, isFile);
      }
      return fileCache.get(relative);
    },
    readAll(files) {
      return new Map(files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]));
    },
  };
}

function gitExecutable() {
  return fs.existsSync('/usr/bin/git') ? '/usr/bin/git' : 'git';
}

function resolveRef(repoRoot, ref) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) throw new Error(`Invalid git ref: ${ref}`);
  return execFileSync(gitExecutable(), ['-C', repoRoot, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSource(repoRoot, ref) {
  const git = gitExecutable();
  const sha = resolveRef(repoRoot, ref);
  const listing = execFileSync(git, ['-C', repoRoot, 'ls-tree', '-r', '-z', '--full-tree', '--name-only', sha], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const files = new Set(listing.split('\0').filter(Boolean));
  return {
    sha,
    list(root) {
      const prefix = root ? `${root}/` : '';
      return [...files].filter((file) => file.startsWith(prefix));
    },
    isFile(relative) {
      return files.has(relative);
    },
    // Same blobs as `git show <sha>:<path>`, read through one `git cat-file --batch`
    // process instead of one `git show` per file (~25ms each).
    readAll(paths) {
      const contents = new Map();
      if (paths.length === 0) return contents;
      const output = execFileSync(git, ['-C', repoRoot, 'cat-file', '--batch'], {
        input: paths.map((file) => `${sha}:${file}\n`).join(''),
        maxBuffer: 1024 * 1024 * 1024,
      });
      let offset = 0;
      for (const file of paths) {
        const headerEnd = output.indexOf(0x0a, offset);
        const header = output.toString('utf8', offset, headerEnd);
        const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
        if (!match) throw new Error(`git cat-file could not read ${sha}:${file}: ${header}`);
        const start = headerEnd + 1;
        const end = start + Number(match[1]);
        contents.set(file, output.toString('utf8', start, end));
        offset = end + 1; // trailing newline after each object
      }
      return contents;
    },
  };
}

// ---------------------------------------------------------------------------
// Scanning

function byteCompare(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sortedUnique(lines) {
  return [...new Set(lines)].sort(byteCompare);
}

function classifySpecifier(specifier) {
  if (specifier.startsWith('node:') || BUILTIN_MODULES.has(specifier)) return 'builtin';
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return 'package';
  return 'repo';
}

function resolveRepoModule(source, repoRoot, fromFile, specifier) {
  const base = specifier.startsWith('/')
    ? toPosix(path.relative(repoRoot, specifier))
    : path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (source.isFile(base)) return base;
  for (const suffix of RESOLVE_SUFFIXES) {
    if (source.isFile(base + suffix)) return base + suffix;
  }
  const extension = path.posix.extname(base);
  const sourceExtension = SOURCE_EXTENSION_FOR[extension];
  if (sourceExtension) {
    const mapped = base.slice(0, -extension.length) + sourceExtension;
    if (source.isFile(mapped)) return mapped;
  }
  return base;
}

function literalText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function isProcessEnv(node) {
  return ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'process'
    && node.name.text === 'env';
}

function envName(node) {
  const parent = node.parent;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === node) return parent.name.text;
  if (parent && ts.isElementAccessExpression(parent) && parent.expression === node) {
    return literalText(parent.argumentExpression) ?? '*';
  }
  return '*';
}

function moduleSpecifiers(sourceFile) {
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const text = literalText(node.moduleSpecifier);
      if (text !== undefined) specifiers.push(text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const text = literalText(node.moduleReference.expression);
      if (text !== undefined) specifiers.push(text);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const text = (isRequire || isDynamicImport) ? literalText(node.arguments[0]) : undefined;
      if (text !== undefined) specifiers.push(text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      // `typeof import('...')` / `import('...').T`: the type-position spelling of import().
      const text = literalText(node.argument.literal);
      if (text !== undefined) specifiers.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function envReads(sourceFile) {
  const names = [];
  const visit = (node) => {
    if (isProcessEnv(node)) {
      names.push(envName(node));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function runtimeIdLiterals(sourceFile) {
  const counts = new Map();
  const count = (node) => {
    const text = literalText(node);
    if (text !== undefined && RUNTIME_IDS.has(text)) counts.set(text, (counts.get(text) ?? 0) + 1);
  };
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      count(node.left);
      count(node.right);
    } else if (ts.isCaseClause(node)) {
      count(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return counts;
}

function parse(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/**
 * Scan the working tree (default) or a git ref.
 * @returns {{imports: string[], env: string[], runtimeIds: string[]}} byte-sorted fixture lines
 */
function scan(repoRoot, options = {}) {
  const root = path.resolve(repoRoot);
  const source = options.ref !== undefined ? gitSource(root, options.ref) : fsSource(root);
  const isCandidate = createMatcher(CANDIDATE_GLOBS);
  const isRuntimeIdScope = createMatcher(RUNTIME_ID_GLOBS);
  const files = sortedUnique(scanRoots([...CANDIDATE_GLOBS, ...RUNTIME_ID_GLOBS]).flatMap((dir) => source.list(dir)))
    .filter((file) => isCandidate(file) || isRuntimeIdScope(file));
  const contents = source.readAll(files);

  const imports = [];
  const env = [];
  const runtimeIds = [];
  for (const file of files) {
    const candidate = isCandidate(file);
    const runtimeIdScope = isRuntimeIdScope(file);
    const text = contents.get(file);
    if (!candidate && !RUNTIME_ID_TEXT.test(text)) continue;
    const sourceFile = parse(file, text);

    if (candidate) {
      const fromRuntimePackage = file.startsWith(RUNTIME_PACKAGE_PREFIX);
      for (const specifier of moduleSpecifiers(sourceFile)) {
        if (classifySpecifier(specifier) !== 'repo') continue;
        const target = resolveRepoModule(source, root, file, specifier);
        if (isCandidate(target) && !(fromRuntimePackage && target.startsWith('backend/'))) continue;
        imports.push(`${file}\t${target}`);
      }
      for (const name of envReads(sourceFile)) env.push(`${file}\t${name}`);
    }
    if (runtimeIdScope) {
      for (const [literal, total] of runtimeIdLiterals(sourceFile)) runtimeIds.push(`${file}\t${literal}\t${total}`);
    }
  }
  return { imports: sortedUnique(imports), env: sortedUnique(env), runtimeIds: sortedUnique(runtimeIds) };
}

// ---------------------------------------------------------------------------
// Fixtures

function runtimeIdKey(line) {
  return line.slice(0, line.lastIndexOf('\t'));
}

function runtimeIdCount(line) {
  return Number(line.slice(line.lastIndexOf('\t') + 1));
}

function readFixtureLines(file, kind) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const lines = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim() === '' || line.startsWith('#')) return;
    const columns = line.split('\t');
    const validCount = kind.columns !== 3 || /^[1-9][0-9]*$/.test(columns[2] ?? '');
    if (columns.length !== kind.columns || columns.some((column) => column === '') || !validCount) {
      throw new Error(`${path.basename(file)}:${index + 1}: expected ${kind.describe}, got ${JSON.stringify(line)}`);
    }
    lines.push(line);
  });
  return lines;
}

/**
 * Load `<kind>.txt` merged with `<kind>.pending.txt`; runtime-id counts merge by maximum.
 * `{ pending: false }` reads only the baseline, `{ baseline: false }` only the pending files.
 */
function loadFixture(dir, options = {}) {
  const { baseline = true, pending = true } = options;
  const fixture = {};
  for (const kind of KINDS) {
    const lines = [
      ...(baseline ? readFixtureLines(path.join(dir, `${kind.file}.txt`), kind) : []),
      ...(pending ? readFixtureLines(path.join(dir, `${kind.file}.pending.txt`), kind) : []),
    ];
    if (kind.columns === 3) {
      const max = new Map();
      for (const line of lines) {
        const key = runtimeIdKey(line);
        max.set(key, Math.max(max.get(key) ?? 0, runtimeIdCount(line)));
      }
      fixture[kind.key] = sortedUnique([...max].map(([key, total]) => `${key}\t${total}`));
    } else {
      fixture[kind.key] = sortedUnique(lines);
    }
  }
  return fixture;
}

/**
 * Added: present now but not in the fixture, or a runtime-id count above it (fails the check).
 * Stale: in the fixture but gone now, or a runtime-id count below it (informational).
 */
function compare(current, fixture) {
  const added = {};
  const stale = {};
  for (const kind of KINDS) {
    const now = current[kind.key] ?? [];
    const allowed = fixture[kind.key] ?? [];
    if (kind.columns === 3) {
      const nowCounts = new Map(now.map((line) => [runtimeIdKey(line), runtimeIdCount(line)]));
      const allowedCounts = new Map(allowed.map((line) => [runtimeIdKey(line), runtimeIdCount(line)]));
      added[kind.key] = now.filter((line) => runtimeIdCount(line) > (allowedCounts.get(runtimeIdKey(line)) ?? 0));
      stale[kind.key] = allowed.filter((line) => runtimeIdCount(line) > (nowCounts.get(runtimeIdKey(line)) ?? 0));
    } else {
      const nowSet = new Set(now);
      const allowedSet = new Set(allowed);
      added[kind.key] = now.filter((line) => !allowedSet.has(line));
      stale[kind.key] = allowed.filter((line) => !nowSet.has(line));
    }
  }
  return { added, stale, hasAdded: KINDS.some((kind) => added[kind.key].length > 0) };
}

function writeFixture(dir, current) {
  fs.mkdirSync(dir, { recursive: true });
  for (const kind of KINDS) {
    const header = [
      `# Runtime boundary baseline, ${kind.label}.`,
      `# ${kind.describe}`,
      '# One entry per line, byte-sorted; # lines are comments. New entries fail',
      '# backend/test/runtimeBoundary.test.ts and the backend build (see AGENTS.md).',
      '# Regenerate with: node backend/scripts/runtimeBoundary.cjs --write (leaves *.pending.txt alone).',
    ];
    fs.writeFileSync(path.join(dir, `${kind.file}.txt`), `${[...header, ...current[kind.key]].join('\n')}\n`);
  }
}

// ---------------------------------------------------------------------------
// Reporting

function counts(entries) {
  return KINDS.map((kind) => `${kind.file} ${entries[kind.key].length}`).join(', ');
}

function formatComparison(comparison) {
  const sections = [];
  for (const kind of KINDS) {
    const added = comparison.added[kind.key];
    if (added.length > 0) sections.push(`New ${kind.label} (${kind.file}):\n${added.join('\n')}`);
  }
  if (sections.length > 0) sections.push(REMEDIATION);
  return sections.join('\n\n');
}

/** Baseline entries that no longer occur. Pending entries are expected to be absent until their branch lands. */
function formatStale(baselineStale) {
  const sections = [];
  for (const kind of KINDS) {
    const stale = baselineStale[kind.key];
    if (stale.length > 0) sections.push(`Stale ${kind.file}.txt entries (no longer present):\n${stale.join('\n')}`);
  }
  if (sections.length > 0) sections.push('Run `node backend/scripts/runtimeBoundary.cjs --write` to drop them.');
  return sections.join('\n\n');
}

/** Scan the repository and compare it with the fixture; used by the CLI and the backend build. */
function runCheck(repoRoot = REPO_ROOT, fixtureDir = FIXTURE_DIR) {
  const started = Date.now();
  const current = scan(repoRoot);
  const comparison = compare(current, loadFixture(fixtureDir));
  const baselineStale = compare(current, loadFixture(fixtureDir, { pending: false })).stale;
  const pendingAbsent = compare(current, loadFixture(fixtureDir, { baseline: false })).stale;
  const pendingCount = KINDS.reduce((total, kind) => total + pendingAbsent[kind.key].length, 0);
  const pendingNote = pendingCount > 0 ? `; ${pendingCount} *.pending.txt entries not on this branch yet` : '';
  return {
    current,
    comparison,
    hasAdded: comparison.hasAdded,
    summary: `runtime boundary: ${counts(current)} (${Date.now() - started}ms${pendingNote})`,
    failure: formatComparison(comparison),
    stale: formatStale(baselineStale),
  };
}

function main(argv) {
  const usage = 'Usage: node backend/scripts/runtimeBoundary.cjs [--write | --ref <git-ref>]';
  let write = false;
  let ref;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') write = true;
    else if (arg === '--ref') ref = argv[++i];
    else if (arg.startsWith('--ref=')) ref = arg.slice('--ref='.length);
    else if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    else { console.error(`Unknown argument: ${arg}\n${usage}`); return 2; }
  }
  if ((write && ref !== undefined) || (argv.includes('--ref') && ref === undefined)) {
    console.error(usage);
    return 2;
  }

  if (ref !== undefined) {
    const sha = resolveRef(REPO_ROOT, ref);
    const current = scan(REPO_ROOT, { ref });
    const out = [`# runtime boundary scan: ${ref} @ ${sha}`];
    for (const kind of KINDS) out.push(`# ${kind.file} (${current[kind.key].length})`, ...current[kind.key]);
    process.stdout.write(`${out.join('\n')}\n`);
    return 0;
  }

  if (write) {
    const current = scan(REPO_ROOT);
    writeFixture(FIXTURE_DIR, current);
    console.log(`Wrote ${toPosix(path.relative(REPO_ROOT, FIXTURE_DIR))}/*.txt: ${counts(current)}`);
    return 0;
  }

  const result = runCheck();
  console.log(result.summary);
  if (result.stale) console.log(`\n${result.stale}`);
  if (result.hasAdded) {
    console.error(`\n${result.failure}`);
    return 1;
  }
  return 0;
}

module.exports = {
  CANDIDATE_GLOBS,
  RUNTIME_ID_GLOBS,
  KINDS,
  REMEDIATION,
  scan,
  loadFixture,
  compare,
  writeFixture,
  runCheck,
  formatComparison,
  // Scanner helpers reused by scripts/dependencyRules.cjs.
  createMatcher,
  scanRoots,
  fsSource,
  parse,
  moduleSpecifiers,
  classifySpecifier,
  resolveRepoModule,
  sortedUnique,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
