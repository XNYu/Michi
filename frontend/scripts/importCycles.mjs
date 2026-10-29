// Finds runtime import cycles among the frontend's source files.
//
// An edge is an import the bundler keeps: TypeScript drops `import type`,
// type-only specifiers and imports whose bindings are used only in type
// positions, so those cannot form a runtime cycle. Dynamic import() counts,
// because the module graph still loops when the chunk loads.
//
// Usage: node frontend/scripts/importCycles.mjs [srcDir]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

function listSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      listSourceFiles(path, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts') && !/\.test\.[^.]+$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier.replace(/\?.*$/, ''));
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

/** Whether an identifier reads a binding, as opposed to naming a declaration, property or label. */
function isReference(id) {
  const parent = id.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return parent.name === id;
  if (ts.isExportSpecifier(parent)) return (parent.propertyName ?? parent.name) === id;
  return parent.name !== id && parent.propertyName !== id && parent.label !== id;
}

/** Names read in value positions anywhere in the file. */
function valueReferences(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isExportDeclaration(node) && (node.isTypeOnly || node.moduleSpecifier)) return;
    if (ts.isExportSpecifier(node) && node.isTypeOnly) return;
    if (ts.isHeritageClause(node)) {
      // `class A extends B<T>` reads B; `implements` is type-only.
      if (node.token === ts.SyntaxKind.ExtendsKeyword) node.types.forEach((type) => visit(type.expression));
      return;
    }
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node) && isReference(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** Module specifiers of the imports that survive TypeScript import elision, in source order. */
export function runtimeImportSpecifiers(fileName, text) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const specifiers = [];
  const candidates = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (!clause) {
        specifiers.push(statement.moduleSpecifier.text);
        continue;
      }
      if (clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      const locals = [
        ...(clause.name ? [clause.name.text] : []),
        ...(bindings && ts.isNamespaceImport(bindings) ? [bindings.name.text] : []),
        ...(bindings && ts.isNamedImports(bindings)
          ? bindings.elements.filter((element) => !element.isTypeOnly).map((element) => element.name.text)
          : []),
      ];
      if (locals.length > 0) candidates.push({ specifier: statement.moduleSpecifier.text, locals });
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      if (statement.isTypeOnly) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.every((element) => element.isTypeOnly)) continue;
      specifiers.push(statement.moduleSpecifier.text);
    }
  }
  const used = valueReferences(sourceFile);
  for (const { specifier, locals } of candidates) {
    if (locals.some((local) => used.has(local))) specifiers.push(specifier);
  }
  const findDynamic = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
    }
    ts.forEachChild(node, findDynamic);
  };
  findDynamic(sourceFile);
  return specifiers;
}

/**
 * Strongly connected components of the runtime import graph under `srcDir`
 * that contain a cycle. Each has its files and the edges between them, as
 * sorted `/`-separated paths relative to `srcDir`.
 */
export function findRuntimeImportCycles(srcDir) {
  const root = resolve(srcDir);
  const rel = (path) => relative(root, path).split(sep).join('/');
  const graph = new Map();
  for (const file of listSourceFiles(root)) {
    const targets = new Set();
    for (const specifier of runtimeImportSpecifiers(file, readFileSync(file, 'utf8'))) {
      const target = resolveRelative(file, specifier);
      if (target) targets.add(target);
    }
    graph.set(file, targets);
  }

  // Tarjan's algorithm, iterative so a deep import chain cannot overflow the stack.
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  let next = 0;
  for (const start of graph.keys()) {
    if (index.has(start)) continue;
    const work = [{ node: start, targets: [...(graph.get(start) ?? [])], position: 0 }];
    index.set(start, next);
    low.set(start, next);
    next += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.position < frame.targets.length) {
        const target = frame.targets[frame.position];
        frame.position += 1;
        if (!graph.has(target)) continue;
        if (!index.has(target)) {
          index.set(target, next);
          low.set(target, next);
          next += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, targets: [...graph.get(target)], position: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(target)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(frame.node)));
      }
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const members = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.node);
      if (members.length > 1 || graph.get(frame.node).has(frame.node)) components.push(members);
    }
  }

  return components
    .map((members) => {
      const inside = new Set(members);
      const edges = members.flatMap((from) => [...graph.get(from)]
        .filter((to) => inside.has(to))
        .map((to) => `${rel(from)} -> ${rel(to)}`));
      return { files: members.map(rel).sort(), edges: edges.sort() };
    })
    .sort((a, b) => a.files[0].localeCompare(b.files[0]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srcDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const cycles = findRuntimeImportCycles(srcDir);
  for (const cycle of cycles) {
    console.log(`cycle (${cycle.files.length} files):\n  ${cycle.edges.join('\n  ')}`);
  }
  console.log(`${cycles.length} runtime import cycle(s) in ${srcDir}`);
}
