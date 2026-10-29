// Builds dist/: this package as CommonJS with .d.ts, which scripts/pack.mjs
// stages for local boundary checks. Michi itself runs the package from src/
// and never reads dist/.
//
//   npm run build -w michi-runtime     (builds shared/ first)
//
// 1. tsc -p tsconfig.build.json: src/ -> dist/, one .js and .d.ts per module.
//    Declarations marked @internal stay out of the .d.ts; only the files in
//    INTERNAL_MARKERS may mark any, as many as it says.
// 2. michi-shared is not published. The shared modules this package
//    uses, with the ones they import, are copied from shared/dist/ into
//    dist/vendor/michi-shared/, and every import of the package is rewritten
//    to that copy.
// 3. Crew's three process entries become self-contained CommonJS bundles in
//    dist/adapters/crew/, where crewLaunch and crewMcpHost look for them.
//    The packages each inlines must be at package-lock.json's versions, and
//    it ends with their license files.
// 4. Files the adapters read at run time are copied beside their modules.
// 5. Each public entry gets an .mjs wrapper that re-exports its CommonJS
//    module, so import and require share one module instance.
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { ASSETS, CREW_BUNDLES, EXCLUDED_SHARED_MODULES, INTERNAL_MARKERS, LICENSE_NOTICES_HEADER, PUBLIC_ENTRIES } from './packageLayout.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..');
const src = join(pkgRoot, 'src');
const dist = join(pkgRoot, 'dist');
const require = createRequire(join(pkgRoot, 'package.json'));

const SHARED = 'michi-shared';
// Reject bare workspace imports while allowing the relative vendored copy.
const SHARED_REFERENCE = /(["'])michi-shared(?:\/[^"']*)?\1/;
const vendorDir = join(dist, 'vendor', 'michi-shared');

/** What happens to a file under src/ that is not TypeScript: copied to the same path in dist/, or left out. */
function assetPolicy(file) {
  if (ASSETS.includes(file)) return 'copy';
  // Michi's own Crew guides: its UI, installer and validation runs, not this package's API.
  if (/^adapters\/crew\/[^/]+\.md$/.test(file)) return 'leave out';
  return undefined;
}

class BuildError extends Error {}
const fail = (message) => { throw new BuildError(message); };

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}

const slash = (file) => file.split(sep).join('/');

/**
 * tsconfig.build.json's stripInternal leaves every declaration marked
 * @internal out of dist/'s .d.ts, a public one marked by mistake included,
 * so INTERNAL_MARKERS lists the files that may carry the mark and how many
 * marks each holds.
 */
function assertInternalMarkers() {
  const found = new Map();
  for (const file of walk(src)) {
    if (!file.endsWith('.ts')) continue;
    const count = readFileSync(file, 'utf8').split('@internal').length - 1;
    if (count > 0) found.set(slash(relative(src, file)), count);
  }
  const problems = [];
  for (const [file, count] of found) {
    const listed = INTERNAL_MARKERS[file];
    if (listed === undefined) problems.push(`${file} has ${count} and is not listed`);
    else if (listed !== count) problems.push(`${file} has ${count}, not the ${listed} listed`);
  }
  for (const file of Object.keys(INTERNAL_MARKERS)) {
    if (!found.has(file)) problems.push(`${file} is listed but has none`);
  }
  if (problems.length > 0) {
    fail('the @internal marks under src/, whose declarations the published .d.ts leave out, must be the ones '
      + `INTERNAL_MARKERS in scripts/packageLayout.mjs lists (${problems.join('; ')})`);
  }
}

function compile() {
  const tsc = require.resolve('typescript/lib/tsc.js');
  try {
    execFileSync(process.execPath, [tsc, '-p', join(pkgRoot, 'tsconfig.build.json')], { stdio: 'inherit' });
  } catch {
    fail('tsc -p tsconfig.build.json failed');
  }
}

/** The names a module's .d.ts exports. Declarations only; nothing is type-checked. */
function exportSymbols(dtsFile) {
  const program = ts.createProgram([dtsFile], { noEmit: true, skipLibCheck: true, types: [] });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(dtsFile));
  if (!moduleSymbol) fail(`${dtsFile} is not a module`);
  return { checker, symbols: checker.getExportsOfModule(moduleSymbol) };
}

/** Each name shared's index exports, to the shared modules that declare it. */
function declaringModules(sharedDist, names) {
  const { checker, symbols } = exportSymbols(join(sharedDist, 'index.d.ts'));
  const declaring = new Map();
  for (const symbol of symbols) {
    if (!names.has(symbol.name)) continue;
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const modules = new Set();
    for (const declaration of target.declarations ?? []) {
      const file = relative(sharedDist, declaration.getSourceFile().fileName);
      if (file.includes(sep) || !file.endsWith('.d.ts')) fail(`${SHARED} exports ${symbol.name} from ${file}`);
      modules.add(file.slice(0, -'.d.ts'.length));
    }
    declaring.set(symbol.name, modules);
  }
  return declaring;
}

/** Adds to `names` what `file` imports or re-exports from shared, and refuses forms the vendoring cannot follow. */
function collectSharedNames(file, names) {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const isShared = (node) => !!node && ts.isStringLiteral(node) && node.text === SHARED;
  const where = (node) => `${relative(pkgRoot, file)}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && isShared(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (node.importClause?.name || !bindings || !ts.isNamedImports(bindings)) fail(`${where(node)}: only named imports of ${SHARED} can be vendored`);
      for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
    } else if (ts.isExportDeclaration(node) && isShared(node.moduleSpecifier)) {
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)) fail(`${where(node)}: only named re-exports of ${SHARED} can be vendored`);
      for (const element of node.exportClause.elements) names.add((element.propertyName ?? element.name).text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && isShared(node.argument.literal)) {
      let qualifier = node.qualifier;
      if (!qualifier) fail(`${where(node)}: import("${SHARED}") needs a member`);
      while (ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
      names.add(qualifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && isShared(node.moduleReference.expression)) {
      // tsc emits a plain require of the whole package, whose names are never collected.
      fail(`${where(node)}: import = require("${SHARED}") cannot be vendored; use named imports`);
    } else if (ts.isCallExpression(node) && isShared(node.arguments[0])) {
      fail(`${where(node)}: a call loading ${SHARED} cannot be vendored`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const RELATIVE_SPECIFIER = /(?:\brequire\(\s*|\bfrom\s+|\bimport\(\s*)["'](\.\.?\/[^"']+)["']/g;

/**
 * `modules` (each with why it is needed) and every shared module they import,
 * transitively, each to why it is needed. Shared is one flat directory.
 */
function importClosure(sharedDist, modules) {
  const closure = new Map();
  const queue = [...modules];
  while (queue.length > 0) {
    const [module, why] = queue.pop();
    if (closure.has(module)) continue;
    closure.set(module, why);
    for (const ext of ['.js', '.d.ts']) {
      for (const [, specifier] of readFileSync(join(sharedDist, module + ext), 'utf8').matchAll(RELATIVE_SPECIFIER)) {
        const target = specifier.replace(/^\.\//, '').replace(/\.js$/, '');
        if (target.includes('/') || !existsSync(join(sharedDist, `${target}.js`))) {
          fail(`shared ${module}${ext} imports ${specifier}, which is not a module beside it`);
        }
        queue.push([target, `imported by ${module}`]);
      }
    }
  }
  return closure;
}

const EXPORT_STAR_JS = /^__exportStar\(require\("\.\/([^"]+)"\), exports\);$/;
const EXPORT_STAR_DTS = /^export \* from '\.\/([^']+)';$/;
const BARREL_NOTE = "// The modules of Michi's shared package that this package uses (scripts/build.mjs).";

/**
 * dist/vendor/michi-shared/index.{js,d.ts}: shared's own index, keeping the
 * `export *` of `modules` only. Returns every module shared's index re-exports.
 */
function writeBarrels(sharedDist, modules) {
  const js = readFileSync(join(sharedDist, 'index.js'), 'utf8').split('\n');
  const dts = readFileSync(join(sharedDist, 'index.d.ts'), 'utf8').split('\n');
  for (const line of dts) {
    if (line.trim() && !EXPORT_STAR_DTS.test(line)) fail(`shared index.d.ts is not only export *: ${line}`);
  }
  const listed = (lines, pattern) => lines.map((line) => pattern.exec(line)?.[1]).filter(Boolean);
  const all = listed(dts, EXPORT_STAR_DTS);
  if (listed(js, EXPORT_STAR_JS).join() !== all.join()) fail('shared index.js and index.d.ts re-export different modules');
  for (const module of modules) {
    if (!all.includes(module)) fail(`shared index does not re-export ${module}`);
  }
  const keep = (pattern) => (line) => { const module = pattern.exec(line)?.[1]; return !module || modules.has(module); };
  writeFileSync(join(vendorDir, 'index.js'), [BARREL_NOTE, ...js.filter(keep(EXPORT_STAR_JS))].join('\n'));
  writeFileSync(join(vendorDir, 'index.d.ts'), [BARREL_NOTE, ...dts.filter(keep(EXPORT_STAR_DTS))].join('\n'));
  return all;
}

function vendorShared() {
  const sharedDist = dirname(realpathSync(require.resolve(SHARED)));
  // Value and type imports in the source, plus the types tsc wrote into the
  // declarations on its own (an inferred return type, say).
  const names = new Set();
  for (const file of walk(src)) if (file.endsWith('.ts')) collectSharedNames(file, names);
  for (const file of walk(dist)) if (file.endsWith('.d.ts')) collectSharedNames(file, names);
  const declaring = declaringModules(sharedDist, names);
  const used = new Map(); // shared module -> the names the package uses from it
  for (const name of names) {
    const modules = declaring.get(name) ?? fail(`${SHARED} does not export ${name}`);
    for (const module of modules) used.set(module, [...(used.get(module) ?? []), name]);
  }
  const direct = new Set(used.keys());
  const closure = importClosure(sharedDist, [...used].map(([module, uses]) => [module, `declares ${uses.sort().join(', ')}`]));
  const excluded = [...closure].filter(([module]) => EXCLUDED_SHARED_MODULES.includes(module));
  if (excluded.length > 0) {
    fail(`the vendored copy of shared would include modules of Michi's product code, which must not ship `
      + `(EXCLUDED_SHARED_MODULES in scripts/packageLayout.mjs): `
      + `${excluded.map(([module, why]) => `${module} (${why})`).join('; ')}. `
      + 'Use something outside them, or move what the package needs to a shared module of its own.');
  }
  mkdirSync(vendorDir, { recursive: true });
  for (const module of closure.keys()) {
    for (const ext of ['.js', '.d.ts']) copyFileSync(join(sharedDist, module + ext), join(vendorDir, module + ext));
  }
  const all = writeBarrels(sharedDist, direct);
  const unknown = EXCLUDED_SHARED_MODULES.filter((module) => !all.includes(module));
  if (unknown.length > 0) fail(`EXCLUDED_SHARED_MODULES names ${unknown.join(', ')}, which shared's index does not re-export`);
  const exported = new Set(exportSymbols(join(vendorDir, 'index.d.ts')).symbols.map((symbol) => symbol.name));
  const missing = [...names].filter((name) => !exported.has(name));
  if (missing.length > 0) fail(`the vendored shared index does not export ${missing.join(', ')}`);
  return { names: names.size, modules: [...closure.keys()].sort(), leftOut: all.filter((module) => !closure.has(module)).sort() };
}

const SHARED_SPECIFIER = /(\brequire\(\s*|\bfrom\s+|\bimport\(\s*)(["'])michi-shared\2/g;

/** Points every import of shared in dist/ at the vendored copy. */
function rewriteSharedImports() {
  let count = 0;
  for (const file of walk(dist)) {
    if (file.startsWith(vendorDir + sep) || !/\.(js|d\.ts)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    let target = slash(relative(dirname(file), vendorDir));
    if (!target.startsWith('.')) target = `./${target}`;
    const next = text.replace(SHARED_SPECIFIER, (_, lead, quote) => { count += 1; return `${lead}${quote}${target}${quote}`; });
    if (next !== text) writeFileSync(file, next);
  }
  return count;
}

/** The relative specifiers `file` loads with require() or import(). */
function relativeLoads(file) {
  const sourceFile = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const loads = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text.startsWith('.')
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      loads.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return loads;
}

/**
 * No module of the package may load a Crew process entry. Each runs as its
 * own process and ships as a bundle with its own copy of every module it uses
 * (crewMcpHost.js replaces tsc's module of that name), so a host process that
 * loaded one would get a second runtimeLifecycle, and whatever core the entry
 * pulls in, beside the package's single instance. Runs on tsc's output, before
 * the bundles are written.
 */
function assertProcessEntriesNotLoaded() {
  const entries = new Set(CREW_BUNDLES.map(([entry]) => join(dist, entry.replace(/\.ts$/, '.js'))));
  const problems = [];
  for (const file of walk(dist)) {
    if (!file.endsWith('.js') || file.startsWith(vendorDir + sep)) continue;
    for (const specifier of relativeLoads(file)) {
      const target = resolve(dirname(file), specifier);
      const loaded = [target, `${target}.js`, join(target, 'index.js')].find((candidate) => entries.has(candidate));
      if (loaded) problems.push(`${slash(relative(dist, file))} loads ${slash(relative(dist, loaded))}`);
    }
  }
  if (problems.length > 0) {
    fail(`modules of the package load a Crew process entry. An entry runs as its own process and ships as a bundle `
      + `with its own copy of every module it uses (core's runtimeLifecycle among them), so a host process loading it `
      + `would hold a second instance of those modules. Move what they need out of the entry:\n${problems.join('\n')}`);
  }
}

/**
 * esbuild notes each module a bundle inlines by its path relative to the
 * working directory. Pinning that to the package root and keeping symlinked
 * paths as they are (a worktree's node_modules may link into another
 * checkout) keeps those notes inside the repository, so the bundles carry no
 * path of the machine that built them. Fails on a module from outside it.
 */
function assertInputsInsideRepository(outName, metafile) {
  const outside = Object.keys(metafile.inputs).filter((input) =>
    isAbsolute(input) || relative(repoRoot, resolve(pkgRoot, input)).startsWith('..'));
  if (outside.length > 0) {
    fail(`${outName} would inline modules from outside the repository, and with them paths of this machine:\n`
      + outside.slice(0, 10).join('\n'));
  }
}

/** The third-party packages a bundle inlines, from its metafile: [directory, package.json] by name, then version. */
function inlinedPackages(metafile) {
  const packages = new Map(); // package directory -> its package.json
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(slash(input));
    if (!match) continue;
    const dir = resolve(pkgRoot, match[1]);
    if (!packages.has(dir)) packages.set(dir, JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...packages].sort(([, a], [, b]) => order(a.name, b.name) || order(a.version, b.version));
}

/**
 * A bundle inlines what node_modules holds, which can lag behind the commit
 * being built: a pulled package-lock.json nobody installed yet. Every inlined
 * package's version must be the one package-lock.json pins at its path, so
 * the bundles are what this commit's lockfile says they are.
 */
function assertInlinedPackagesLocked(outName, packages) {
  const locked = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')).packages ?? {};
  const drift = [];
  for (const [dir, manifest] of packages) {
    const key = slash(relative(repoRoot, dir));
    const version = locked[key]?.version;
    if (version !== manifest.version) {
      drift.push(`${manifest.name}: ${key} holds ${manifest.version}, package-lock.json ${version ? `pins ${version}` : 'has no entry for it'}`);
    }
  }
  if (drift.length > 0) {
    fail(`${outName} would inline packages that differ from package-lock.json:\n${drift.join('\n')}\n`
      + 'Run npm ci (or npm install) at the repository root, then build again.');
  }
}

const LICENSE_FILE = /^licen[cs]e(?:[.-][\w.-]+)?$/i;
// Apache-2.0 §4(d): a NOTICE file goes with every copy.
const NOTICE_FILE = /^notice(?:[.-][\w.-]+)?$/i;
// JavaScript ends a // comment at CR, LS and PS too; these and the other
// Unicode line breaks become \n, so no text of a file leaves its comment.
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

/** The license a package.json declares, for a notice heading: its SPDX expression without outer parentheses. */
function declaredLicense(manifest) {
  const { license, licenses } = manifest;
  const named = typeof license === 'string' ? license
    : typeof license?.type === 'string' ? license.type
      : Array.isArray(licenses) ? licenses.map((entry) => entry?.type ?? entry).filter((entry) => typeof entry === 'string').join(' OR ')
        : '';
  let expression = named.trim().replace(/\s+/g, ' ');
  // `(MIT OR Apache-2.0)` loses its parentheses, `(MIT) AND (ISC)` keeps them.
  let depth = 0;
  let closes = -1;
  for (let i = 0; i < expression.length && closes < 0; i += 1) {
    depth += (expression[i] === '(') - (expression[i] === ')');
    if (depth === 0) closes = i;
  }
  if (expression.startsWith('(') && closes === expression.length - 1) expression = expression.slice(1, -1).trim();
  return expression || 'see file';
}

/**
 * The packages a bundle inlines ship their copyright and license notices in
 * files beside their code, not as legal comments esbuild would keep. Appends
 * to the bundle, in the format LICENSE_NOTICES_HEADER describes, each
 * package's name@version and its license and NOTICE files, in the order of
 * `packages`. Fails on a package without a license file.
 */
function appendLicenseNotices(outName, packages) {
  const lines = [LICENSE_NOTICES_HEADER];
  for (const [dir, manifest] of packages) {
    const names = readdirSync(dir);
    const licenses = names.filter((file) => LICENSE_FILE.test(file)).sort();
    if (licenses.length === 0) {
      fail(`${outName} inlines ${manifest.name}@${manifest.version}, which has no license file in ${slash(relative(pkgRoot, dir))}`);
    }
    const license = declaredLicense(manifest);
    for (const file of [...licenses, ...names.filter((name) => NOTICE_FILE.test(name)).sort()]) {
      lines.push('//', `// --- ${manifest.name}@${manifest.version} (${license}): ${file} ---`);
      const text = readFileSync(join(dir, file), 'utf8').replace(LINE_BREAK, '\n').replace(/\s+$/, '');
      for (const line of text.split('\n')) lines.push(`// ${line}`.trimEnd());
    }
  }
  appendFileSync(join(dist, 'adapters/crew', outName), `\n${lines.join('\n')}\n`);
}

async function bundleCrewEntries() {
  const vendored = {
    name: 'vendored-michi-shared',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^michi-shared$/ }, () => ({ path: join(vendorDir, 'index.js') }));
    },
  };
  const notices = [];
  for (const [entry, outName] of CREW_BUNDLES) {
    const { metafile } = await build({
      entryPoints: [join(src, entry)],
      outfile: join(dist, 'adapters/crew', outName),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      // A legal comment (//!, /*!, @license, @preserve) of an inlined module moves to the end of the bundle.
      legalComments: 'eof',
      tsconfig: join(pkgRoot, 'tsconfig.build.json'),
      absWorkingDir: pkgRoot,
      preserveSymlinks: true,
      metafile: true,
      external: ['node:*'],
      plugins: [vendored],
      logLevel: 'warning',
    });
    assertInputsInsideRepository(outName, metafile);
    const packages = inlinedPackages(metafile);
    assertInlinedPackagesLocked(outName, packages);
    appendLicenseNotices(outName, packages);
    notices.push(`${outName} ${packages.length}`);
  }
  return notices;
}

function copyAssets() {
  const copied = [];
  const leftOut = [];
  for (const file of walk(src)) {
    const rel = slash(relative(src, file));
    if (rel.endsWith('.ts')) continue;
    const policy = assetPolicy(rel);
    if (policy === undefined) fail(`src/${rel} is neither copied nor left out; list it in ASSETS (scripts/packageLayout.mjs) or leave it out in assetPolicy (scripts/build.mjs)`);
    if (policy === 'copy') {
      mkdirSync(dirname(join(dist, rel)), { recursive: true });
      copyFileSync(file, join(dist, rel));
      copied.push(rel);
    } else {
      leftOut.push(rel);
    }
  }
  return { copied, leftOut };
}

function writeEsmWrappers() {
  for (const [subpath, entry] of PUBLIC_ENTRIES) {
    const cjsFile = join(dist, `${entry}.js`);
    if (!existsSync(cjsFile) || !existsSync(join(dist, `${entry}.d.ts`))) {
      fail(`public entry ${subpath} has no module: src/${entry}.ts is missing`);
    }
    const names = Object.keys(require(cjsFile)).filter((name) => name !== '__esModule').sort();
    if (names.length === 0) fail(`public entry ${subpath} exports no value`);
    for (const name of names) {
      if (name === 'default' || !/^[A-Za-z_$][\w$]*$/.test(name)) fail(`public entry ${subpath} exports ${name}, which an .mjs wrapper cannot name`);
    }
    writeFileSync(join(dist, `${entry}.mjs`), [
      '// The ESM entry is the CommonJS module itself, so import and require share one instance.',
      `import cjs from './${basename(entry)}.js';`,
      'export default cjs;',
      'export const {',
      ...names.map((name) => `  ${name},`),
      '} = cjs;',
      '',
    ].join('\n'));
  }
}

/** Nothing in dist/ may name shared or this package's in-repo internal/* paths. */
function assertSelfContained() {
  const offending = walk(dist).filter((file) => {
    const text = readFileSync(file, 'utf8');
    return SHARED_REFERENCE.test(text) || text.includes('michi-runtime/internal');
  });
  if (offending.length > 0) fail(`dist/ still names ${SHARED} or internal/*:\n${offending.map((f) => relative(pkgRoot, f)).join('\n')}`);
}

try {
  assertInternalMarkers();
  rmSync(dist, { recursive: true, force: true });
  compile();
  const shared = vendorShared();
  const rewritten = rewriteSharedImports();
  assertProcessEntriesNotLoaded();
  const notices = await bundleCrewEntries();
  const assets = copyAssets();
  writeEsmWrappers();
  assertSelfContained();
  console.log([
    `[runtime] dist/ built: ${walk(dist).length} files`,
    `  shared: ${shared.names} names from ${shared.modules.length} modules vendored (${shared.modules.join(', ')}); `
      + `${rewritten} imports rewritten; left out: ${shared.leftOut.join(', ')}`,
    `  crew bundles: ${CREW_BUNDLES.map(([, out]) => out).join(', ')}; license notices of the packages they inline: ${notices.join(', ')}`,
    `  assets copied: ${assets.copied.join(', ')}; left out: ${assets.leftOut.join(', ')}`,
    `  public entries: ${PUBLIC_ENTRIES.map(([subpath]) => subpath).join(', ')}`,
  ].join('\n'));
} catch (error) {
  if (!(error instanceof BuildError)) throw error;
  console.error(`[runtime] build failed: ${error.message}`);
  process.exit(1);
}
