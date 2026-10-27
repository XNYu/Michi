// Stages dist/ as a private local validation package and packs it with npm pack. It never
// publishes. Build dist/ first: `npm run pack:check -w michi-runtime`
// runs both.
//
// 1. .pack/package/: dist/, README.md and a private package.json for validation,
//    exporting the public subpaths only, with ws and the MCP SDK as its
//    dependencies and the Claude Agent SDK as an optional peer.
// 2. npm pack --ignore-scripts there; the tarball lands in .pack/.
// 3. Checks the tarball: its files, its package.json, what its modules and
//    declarations import, that nothing names shared or internal/*, that its
//    declarations compile, and that every type they reach is exported by an
//    entry or listed in REACHABLE_UNEXPORTED.
// 4. Unpacks it into .pack/check/node_modules/, type-checks
//    examples/minimal-server-host.ts against it and runs its --check, then
//    runs scripts/packSmoke.mjs beside it: every public subpath by import and
//    by require, one instance.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ASSETS, CREW_BUNDLES, EXCLUDED_SHARED_MODULES, PUBLIC_ENTRIES, REACHABLE_UNEXPORTED } from './packageLayout.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(pkgRoot, 'dist');
const packDir = join(pkgRoot, '.pack');
const stage = join(packDir, 'package');
const checkDir = join(packDir, 'check');
const installed = join(checkDir, 'node_modules', 'michi-runtime');

const SHARED = 'michi-shared';
// Reject bare workspace imports while allowing the relative vendored copy.
const SHARED_REFERENCE = /(["'])michi-shared(?:\/[^"']*)?\1/;
const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk';
const CONDITIONS = ['types', 'import', 'require'];
const crewBundleFiles = CREW_BUNDLES.map(([, outName]) => `dist/adapters/crew/${outName}`);
// A path to an excluded shared module: a vendored file, or a bundle's note of a module it inlined.
const EXCLUDED_SHARED_PATH = new RegExp(String.raw`(?:michi-shared|shared/(?:dist|src))/(?:${EXCLUDED_SHARED_MODULES.join('|')})\b`);
// The sign-in tooling remoteCredentials names; its text must not ship in any form.
const CREDENTIAL_TOOLING = /(?!)/; // Michi uses its public SSH provider.
// Paths of the machine that packs: home directories, and this repository where it is checked out.
const repoRoot = resolve(pkgRoot, '..');
const MACHINE_PATHS = [...new Set([
  '/Users/', '/home/', '\\Users\\',
  ...[homedir(), realpathSync(homedir()), repoRoot, realpathSync(repoRoot)]
    .filter((path) => path.length > 1).map((path) => `${path}${sep}`),
])];

class PackError extends Error {}
const fail = (message) => { throw new PackError(message); };
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const slash = (file) => file.split(sep).join('/');

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}

/** The package.json a host installs: the workspace's identity, the public subpaths, runtime dependencies only. */
function validationManifest() {
  const workspace = readJson(join(pkgRoot, 'package.json'));
  const dependencies = { ...workspace.dependencies };
  delete dependencies[SHARED]; // vendored into dist/vendor/michi-shared by scripts/build.mjs
  for (const [name, range] of Object.entries(dependencies)) {
    if (/^(file|link|workspace):/.test(range)) fail(`dependency ${name}@${range} cannot be published`);
  }
  const exports = {};
  const typesVersions = {};
  for (const [subpath, entry] of PUBLIC_ENTRIES) {
    exports[subpath] = { types: `./dist/${entry}.d.ts`, import: `./dist/${entry}.mjs`, require: `./dist/${entry}.js` };
    // TypeScript's node10 resolution reads no exports; this finds the subpaths' types for it.
    if (subpath !== '.') typesVersions[subpath.slice(2)] = [`dist/${entry}.d.ts`];
  }
  return {
    name: workspace.name,
    private: true, // Runtime remains part of Michi; local pack checks never prepare an npm release.
    version: workspace.version,
    description: workspace.description,
    keywords: workspace.keywords,
    license: workspace.license,
    engines: workspace.engines,
    main: './dist/index.js',
    types: './dist/index.d.ts',
    exports,
    typesVersions: { '*': typesVersions },
    files: ['dist'],
    dependencies,
    peerDependencies: workspace.peerDependencies,
    peerDependenciesMeta: workspace.peerDependenciesMeta,
  };
}

function stagePackage() {
  if (!existsSync(join(dist, 'index.js'))) fail('dist/ is not built; run npm run build -w michi-runtime');
  rmSync(packDir, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  cpSync(dist, join(stage, 'dist'), { recursive: true });
  for (const name of ['README.md', 'LICENSE']) {
    if (existsSync(join(pkgRoot, name))) copyFileSync(join(pkgRoot, name), join(stage, name));
  }
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(validationManifest(), null, 2)}\n`);
}

function npmPack() {
  const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: stage, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32',
  });
  const [result] = JSON.parse(output);
  return { ...result, tarball: join(packDir, result.filename) };
}

function checkFileList(tarball) {
  const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const outside = files.filter((file) => !/^package\/((package\.json|README\.md|LICENSE)|dist\/.+\.(js|mjs|cjs|d\.ts))$/.test(file));
  if (outside.length > 0) fail(`the tarball holds files a host should not get:\n${outside.join('\n')}`);
  const required = [
    'package.json',
    ...PUBLIC_ENTRIES.flatMap(([, entry]) => ['.js', '.mjs', '.d.ts'].map((ext) => `dist/${entry}${ext}`)),
    ...crewBundleFiles,
    ...ASSETS.map((file) => `dist/${file}`),
    'dist/vendor/michi-shared/index.js',
    'dist/vendor/michi-shared/index.d.ts',
  ];
  const missing = required.filter((file) => !files.includes(`package/${file}`));
  if (missing.length > 0) fail(`the tarball lacks:\n${missing.join('\n')}`);
  const excluded = files.filter((file) => EXCLUDED_SHARED_MODULES.some((module) =>
    [`package/dist/vendor/michi-shared/${module}.js`, `package/dist/vendor/michi-shared/${module}.d.ts`].includes(file)));
  if (excluded.length > 0) fail(`the tarball holds shared modules of Michi's product code (EXCLUDED_SHARED_MODULES):\n${excluded.join('\n')}`);
  return files;
}

function unpack(tarball) {
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1']);
  // A package of its own, or Node and TypeScript resolve the package name to
  // this workspace (runtime/package.json is the nearest one above, and
  // self-references by name).
  writeFileSync(join(checkDir, 'package.json'), `${JSON.stringify({ name: 'michi-runtime-pack-check', private: true })}\n`);
}

function checkManifest() {
  const manifest = readJson(join(installed, 'package.json'));
  const subpaths = PUBLIC_ENTRIES.map(([subpath]) => subpath);
  if (JSON.stringify(Object.keys(manifest.exports)) !== JSON.stringify(subpaths)) {
    fail(`exports are ${Object.keys(manifest.exports).join(', ')}, not ${subpaths.join(', ')}`);
  }
  for (const [subpath, targets] of Object.entries(manifest.exports)) {
    if (JSON.stringify(Object.keys(targets)) !== JSON.stringify(CONDITIONS)) fail(`exports["${subpath}"] conditions are not ${CONDITIONS.join(', ')}`);
    for (const target of Object.values(targets)) {
      if (!existsSync(join(installed, target))) fail(`exports["${subpath}"] points at a missing ${target}`);
    }
  }
  const dependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(dependencies) !== JSON.stringify(['@modelcontextprotocol/sdk', 'ws'])) fail(`dependencies are ${dependencies.join(', ')}`);
  if (manifest.peerDependenciesMeta?.[CLAUDE_SDK]?.optional !== true || !manifest.peerDependencies?.[CLAUDE_SDK]) {
    fail(`${CLAUDE_SDK} is not an optional peer`);
  }
  if (manifest.private !== true) fail('the local runtime validation tarball must remain private');
  for (const field of ['devDependencies', 'workspaces', 'scripts']) {
    if (field in manifest) fail(`package.json still has ${field}`);
  }
  if (typeof manifest.engines?.node !== 'string' || !manifest.engines.node.trim()) fail('package.json has no engines.node');
  return manifest;
}

/** The bare specifiers `file` imports: require/import() calls in modules, import/export/import() types in declarations. */
function bareSpecifiers(file) {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Set();
  const add = (node) => { if (node && ts.isStringLiteral(node) && !node.text.startsWith('.')) found.add(node.text); };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isCallExpression(node) && node.arguments.length === 1
      && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const packageOf = (specifier) => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
const isBuiltin = (specifier) => specifier.startsWith('node:') || builtinModules.includes(specifier);

/**
 * Everything the unpacked package names: no shared or internal/* anywhere,
 * no excluded shared module, no text of the sign-in tooling and no path of
 * this machine (a home directory, or where the repository is checked out);
 * modules import only node builtins and dependencies (the Claude Agent SDK is
 * resolved, never imported, by name); declarations only builtins, and the
 * dependencies and the peer that carry their own declarations.
 * The Crew bundles inline their dependencies and are left to packSmoke.mjs.
 */
/** Where a host resolving `name` from the unpacked package finds it, with its package.json; undefined if nowhere. */
function installedPackage(name) {
  for (let dir = installed; ; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(file)) return { dir: dirname(file), manifest: readJson(file) };
    if (dirname(dir) === dir) return undefined;
  }
}

const typedPackages = new Map();
/** Whether `name` carries its own declarations, so a host needs no @types package for it. */
function shipsTypes(name) {
  if (!typedPackages.has(name)) {
    const found = installedPackage(name);
    typedPackages.set(name, !!found && (!!(found.manifest.types || found.manifest.typings || found.manifest.typesVersions)
      || JSON.stringify(found.manifest.exports ?? {}).includes('"types"') || existsSync(join(found.dir, 'index.d.ts'))));
  }
  return typedPackages.get(name);
}

function checkContents(manifest) {
  const problems = [];
  const allowed = new Set(Object.keys(manifest.dependencies));
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}));
  for (const file of walk(installed)) {
    const rel = slash(relative(installed, file));
    const text = readFileSync(file, 'utf8');
    if (SHARED_REFERENCE.test(text)) problems.push(`${rel} names ${SHARED}`);
    if (text.includes('michi-runtime/internal')) problems.push(`${rel} names michi-runtime/internal`);
    const excludedPath = EXCLUDED_SHARED_PATH.exec(text);
    if (excludedPath) problems.push(`${rel} names ${excludedPath[0]}, a shared module that must not ship`);
    const tooling = CREDENTIAL_TOOLING.exec(text);
    if (tooling) problems.push(`${rel} contains "${tooling[0]}" (sign-in tooling of Michi's remote access)`);
    const machinePath = MACHINE_PATHS.find((path) => text.includes(path));
    if (machinePath) problems.push(`${rel} contains ${machinePath}, a path of the machine that built it`);
    if (crewBundleFiles.includes(rel) || ASSETS.some((asset) => rel === `dist/${asset}`)) continue;
    if (!/\.(js|mjs|d\.ts)$/.test(rel)) continue;
    const declaration = rel.endsWith('.d.ts');
    for (const specifier of bareSpecifiers(file)) {
      const name = packageOf(specifier);
      if (isBuiltin(specifier)) continue;
      if (!declaration && allowed.has(name)) continue;
      if (declaration && (allowed.has(name) || peers.has(name))) {
        if (shipsTypes(name)) continue;
        problems.push(`${rel} imports ${specifier}, but ${name} has no declarations of its own: a host would need a types package for it`);
        continue;
      }
      problems.push(`${rel} imports ${specifier}, which is neither a node builtin nor a dependency`);
    }
  }
  if (problems.length > 0) fail(problems.join('\n'));
}

/**
 * Compiles the public declarations as a TypeScript host would: strict,
 * skipLibCheck false, with node10 (esModuleInterop, as CommonJS hosts set it)
 * and with nodenext resolution, against the unpacked package. Offline:
 * TypeScript and @types/node come from this repository. No entry may reach
 * the types of the Claude Agent SDK, an optional peer, so a host type-checks
 * every entry, ./adapters/claude included, without it. Every error fails.
 */
function checkDeclarations(manifest) {
  const tsc = createRequire(join(pkgRoot, 'package.json')).resolve('typescript/lib/tsc.js');
  const typesDir = join(checkDir, 'types');
  mkdirSync(typesDir, { recursive: true });
  const specifiers = Object.keys(manifest.exports).map((subpath) => (subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`));
  const resolutions = [['node10', 'commonjs', '.ts', { esModuleInterop: true }], ['nodenext', 'nodenext', '.mts', {}]];
  for (const [resolution, module, ext, options] of resolutions) {
    const name = `entries-${resolution}`;
    writeFileSync(join(typesDir, `${name}${ext}`), [
      ...specifiers.map((specifier, i) => `import * as e${i} from '${specifier}';`),
      `export const entries = [${specifiers.map((_, i) => `e${i}`).join(', ')}];`,
      '',
    ].join('\n'));
    writeFileSync(join(typesDir, `${name}.json`), `${JSON.stringify({
      compilerOptions: {
        strict: true, target: 'ES2022', module, moduleResolution: resolution, types: ['node'], skipLibCheck: false, noEmit: true, ...options,
      },
      files: [`${name}${ext}`],
    })}\n`);
    // --listFiles prints the program's files whether or not it compiles.
    let output;
    let exitedNonZero = false;
    try {
      output = execFileSync(process.execPath, [tsc, '-p', join(typesDir, `${name}.json`), '--listFiles'], { cwd: typesDir, encoding: 'utf8' });
    } catch (error) {
      output = String(error.stdout ?? '');
      exitedNonZero = true;
    }
    const lines = output.split('\n');
    const sdkFiles = lines.filter((line) => !line.includes('error TS') && line.includes(`node_modules/${CLAUDE_SDK}/`));
    if (sdkFiles.length > 0) {
      fail(`${name}: the public declarations reach the types of ${CLAUDE_SDK}, an optional peer; the program includes:\n`
        + sdkFiles.slice(0, 10).join('\n'));
    }
    const errors = lines.filter((line) => line.includes('error TS'));
    if (exitedNonZero && errors.length === 0) fail(`tsc failed on ${name} without reporting an error:\n${output}`);
    if (errors.length > 0) {
      fail(`the public declarations do not compile (${name}: ${specifiers.join(', ')}; skipLibCheck false):\n${errors.join('\n')}`);
    }
    console.log(`[runtime] declarations: ${name} compiles, without the types of ${CLAUDE_SDK}`);
  }
}

/** The name a type reference, heritage clause, typeof or import() type names, if `node` is one. */
function referencedName(node) {
  let name;
  if (ts.isTypeReferenceNode(node)) name = node.typeName;
  else if (ts.isExpressionWithTypeArguments(node)) name = node.expression;
  else if (ts.isTypeQueryNode(node)) name = node.exprName;
  else if (ts.isImportTypeNode(node)) name = node.qualifier;
  if (!name) return undefined;
  if (ts.isQualifiedName(name)) return name.right;
  return ts.isPropertyAccessExpression(name) ? name.name : name;
}

/**
 * Every named type of the package that the public declarations reach, from
 * each entry's exports through the declarations of what they name, is
 * exported by an entry, or REACHABLE_UNEXPORTED says why not. A host can then
 * name each type a public signature uses. The list may not go stale either.
 */
function checkPublicTypes(manifest) {
  const entryFiles = Object.values(manifest.exports).map((targets) => join(installed, targets.types));
  const program = ts.createProgram(entryFiles, {
    strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, moduleResolution: ts.ModuleResolutionKind.Node10,
    types: ['node'], typeRoots: [join(repoRoot, 'node_modules', '@types')],
  });
  const checker = program.getTypeChecker();
  const target = (symbol) => (symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);
  const exported = new Set();
  for (const file of entryFiles) {
    const source = program.getSourceFile(file) ?? fail(`checkPublicTypes: ${file} is not in the program`);
    for (const symbol of checker.getExportsOfModule(checker.getSymbolAtLocation(source))) exported.add(target(symbol));
  }
  const root = `${slash(installed)}/`;
  const inPackage = (declaration) => slash(declaration.getSourceFile().fileName).startsWith(root);
  const keyOf = (symbol) => {
    const module = slash(relative(join(installed, 'dist'), symbol.declarations.find(inPackage).getSourceFile().fileName));
    return `${module.replace(/\.d\.ts$/, '')}#${symbol.name}`;
  };
  const unexported = new Map(); // key -> the keys of the named declarations that reference it
  const seen = new Set();
  const queue = [...exported];
  while (queue.length > 0) {
    const symbol = queue.shift();
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    for (const declaration of (symbol.declarations ?? []).filter(inPackage)) {
      const visit = (node) => {
        const name = referencedName(node);
        const reached = name && target(checker.getSymbolAtLocation(name));
        if (reached && !(reached.flags & ts.SymbolFlags.TypeParameter) && (reached.declarations ?? []).some(inPackage)) {
          if (!exported.has(reached)) {
            const key = keyOf(reached);
            unexported.set(key, new Set([...(unexported.get(key) ?? []), keyOf(symbol)]));
          }
          queue.push(reached);
        }
        ts.forEachChild(node, visit);
      };
      visit(declaration);
    }
  }
  const problems = [];
  for (const [key, referrers] of [...unexported].sort(([a], [b]) => a.localeCompare(b))) {
    if (!(key in REACHABLE_UNEXPORTED)) {
      problems.push(`${key}, referenced by ${[...referrers].sort().join(', ')}, is reached by the public declarations and exported by no entry`);
    }
  }
  for (const key of Object.keys(REACHABLE_UNEXPORTED)) {
    if (!unexported.has(key)) problems.push(`REACHABLE_UNEXPORTED lists ${key}, which the public declarations no longer reach unexported`);
  }
  if (problems.length > 0) {
    fail(`${problems.join('\n')}\nExport such a type from a public entry, or list it in REACHABLE_UNEXPORTED `
      + '(scripts/packageLayout.mjs) with the reason; remove an entry there that no longer applies.');
  }
  console.log(`[runtime] public types: ${exported.size} exported; the ${unexported.size} reached but unexported are REACHABLE_UNEXPORTED`);
}

const EXAMPLE = join(pkgRoot, 'examples', 'minimal-server-host.ts');

/**
 * The example a host starts from (examples/, which is not in the tarball),
 * against the unpacked package. Its text names no internal/* subpath, no
 * sign-in tooling and no path of this machine, and it imports node builtins
 * and the public subpaths only. It compiles as an ESM file of a TypeScript
 * host: strict, nodenext, verbatimModuleSyntax and erasableSyntaxOnly, since
 * Node runs it by stripping its types; skipLibCheck, as checkDeclarations
 * has compiled the package's declarations strictly already. Then Node runs
 * `--check --runtime all` with nothing of this machine's environment but
 * PATH, and a scratch HOME: every runtime builds, the MCP host listens on
 * 127.0.0.1 (a free port, closed at exit) and it exits 0. No agent starts.
 */
function checkExample(manifest) {
  const text = readFileSync(EXAMPLE, 'utf8');
  const publicSpecifiers = Object.keys(manifest.exports).map((subpath) => (subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`));
  const problems = [];
  if (text.includes('michi-runtime/internal')) problems.push('names michi-runtime/internal');
  const tooling = CREDENTIAL_TOOLING.exec(text);
  if (tooling) problems.push(`contains "${tooling[0]}"`);
  const machinePath = MACHINE_PATHS.find((path) => text.includes(path));
  if (machinePath) problems.push(`contains ${machinePath}`);
  for (const specifier of bareSpecifiers(EXAMPLE)) {
    if (!isBuiltin(specifier) && !publicSpecifiers.includes(specifier)) problems.push(`imports ${specifier}, not a public subpath`);
  }
  if (problems.length > 0) fail(`examples/minimal-server-host.ts ${problems.join('; ')}`);

  const exampleDir = join(checkDir, 'example');
  mkdirSync(exampleDir, { recursive: true });
  copyFileSync(EXAMPLE, join(exampleDir, 'minimal-server-host.ts'));
  writeFileSync(join(exampleDir, 'package.json'), `${JSON.stringify({ name: 'michi-runtime-example-check', private: true, type: 'module' })}\n`);
  writeFileSync(join(exampleDir, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      strict: true, target: 'ES2022', module: 'nodenext', moduleResolution: 'nodenext', verbatimModuleSyntax: true,
      erasableSyntaxOnly: true, types: ['node'], skipLibCheck: true, noEmit: true,
    },
    files: ['minimal-server-host.ts'],
  })}\n`);
  const tsc = createRequire(join(pkgRoot, 'package.json')).resolve('typescript/lib/tsc.js');
  try {
    execFileSync(process.execPath, [tsc, '-p', join(exampleDir, 'tsconfig.json')], { cwd: exampleDir, encoding: 'utf8' });
  } catch (error) {
    fail(`examples/minimal-server-host.ts does not compile against the package:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }
  console.log('[runtime] example: minimal-server-host.ts compiles against the public subpaths');

  const home = mkdtempSync(join(tmpdir(), 'michi-runtime-example-home-'));
  // Node 22.18+ and 24 strip types by default; earlier 22 releases need the flag.
  const stripTypes = process.features.typescript ? [] : ['--experimental-strip-types'];
  let output;
  try {
    output = execFileSync(process.execPath, [...stripTypes, 'minimal-server-host.ts', '--check', '--runtime', 'all'], {
      cwd: exampleDir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    });
  } catch (error) {
    fail(`minimal-server-host.ts --check --runtime all failed (exit ${error.status ?? error.signal}):\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const ready = output.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.step === 'ready');
  const runtimes = ready.map((line) => line.runtime);
  if (JSON.stringify(runtimes) !== JSON.stringify(['kiro', 'crew', 'codex', 'claude'])) fail(`--check built ${runtimes.join(', ') || 'no runtime'}`);
  const notLoopback = ready.filter((line) => !/^http:\/\/127\.0\.0\.1:\d+$/.test(line.baseUrl));
  if (notLoopback.length > 0) fail(`--check: the MCP host's base URL is not loopback: ${notLoopback.map((line) => line.baseUrl).join(', ')}`);
  console.log(`[runtime] example: --check --runtime all exits 0 on http://127.0.0.1:<port>; `
    + ready.map((line) => `${line.runtime} ${line.available ? 'available' : 'unavailable'}`).join(', '));
}

function smoke() {
  copyFileSync(join(pkgRoot, 'scripts/packSmoke.mjs'), join(checkDir, 'packSmoke.mjs'));
  try {
    execFileSync(process.execPath, ['packSmoke.mjs'], { cwd: checkDir, stdio: 'inherit' });
  } catch {
    fail('packSmoke.mjs failed against the unpacked tarball');
  }
}

try {
  stagePackage();
  const packed = npmPack();
  const files = checkFileList(packed.tarball);
  unpack(packed.tarball);
  const manifest = checkManifest();
  checkContents(manifest);
  checkDeclarations(manifest);
  checkPublicTypes(manifest);
  checkExample(manifest);
  smoke();
  console.log(`[runtime] packed ${relative(process.cwd(), packed.tarball)}: ${files.length} entries, `
    + `${packed.size} bytes (${packed.unpackedSize} unpacked), ${packed.integrity}. Not published.`);
} catch (error) {
  if (!(error instanceof PackError)) throw error;
  console.error(`[runtime] pack check failed: ${error.message}`);
  process.exit(1);
}
