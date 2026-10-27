/**
 * The shared ACP core (src/adapters/acp/ and its subdirectories) belongs to no
 * single agent. The runtime-boundary ratchet counts its runtime-id
 * comparisons; this test also keeps out what the ratchet cannot see: imports
 * of an agent's adapter, agent names and engine generations in string
 * literals, agent names in identifiers (such as `_meta.kiro`), and
 * environment reads (`process.env`, `process["env"]`, `const { env } =
 * process`). Comments are not checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import ts from "typescript";

const CORE_DIR = path.join(__dirname, "..", "src", "adapters", "acp");
const SRC_DIR = path.join(CORE_DIR, "..", "..");
/** Relative imports may reach the core itself and the package's core and contract. */
const ALLOWED_DIRS = [CORE_DIR, path.join(SRC_DIR, "core"), path.join(SRC_DIR, "contract")];
const BUILTINS = new Set(builtinModules);
const AGENT_TEXT = /kiro|crew/i;
const ENGINE_TEXT = /^v[23]$/;

interface Finding { file: string; line: number; text: string }

function allowedImport(file: string, spec: string): boolean {
    if (spec.startsWith(".")) {
        const target = path.resolve(path.dirname(file), spec);
        return ALLOWED_DIRS.some((dir) => target.startsWith(dir + path.sep));
    }
    return spec === "michi-shared" || BUILTINS.has(spec.replace(/^node:/, ""));
}

/** `process`, or `globalThis.process` and the like. */
function isProcess(node: ts.Expression): boolean {
    return (ts.isIdentifier(node) && node.text === "process")
        || (ts.isPropertyAccessExpression(node) && node.name.text === "process");
}

/** `process.env`, `process["env"]` (or any computed key), or env destructured from process. */
function readsEnv(node: ts.Node): boolean {
    if (ts.isPropertyAccessExpression(node)) return node.name.text === "env" && isProcess(node.expression);
    if (ts.isElementAccessExpression(node)) {
        return isProcess(node.expression)
            && !(ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text !== "env");
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isProcess(node.initializer)) {
        return node.name.elements.some((element) => {
            if (element.dotDotDotToken) return true;
            const key = element.propertyName ?? element.name;
            return !ts.isIdentifier(key) || key.text === "env";
        });
    }
    return false;
}

function scan(file: string): { imports: Finding[]; literals: Finding[]; names: Finding[]; env: Finding[] } {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const out = { imports: [] as Finding[], literals: [] as Finding[], names: [] as Finding[], env: [] as Finding[] };
    const at = (node: ts.Node, text: string): Finding =>
        ({ file: path.relative(CORE_DIR, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
    const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const spec = node.moduleSpecifier.text;
            if (!allowedImport(file, spec)) out.imports.push(at(node, spec));
        } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
            && (node.expression.getText(source) === "require" || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
            const spec = node.arguments[0].text;
            if (!allowedImport(file, spec)) out.imports.push(at(node, spec));
        } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
            || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
            const parent = node.parent;
            const isSpecifier = parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent));
            if (!isSpecifier && (AGENT_TEXT.test(node.text) || ENGINE_TEXT.test(node.text))) out.literals.push(at(node, node.text));
        } else if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
            if (AGENT_TEXT.test(node.text)) out.names.push(at(node, node.text));
        }
        if (readsEnv(node)) out.env.push(at(node, node.getText(source)));
        ts.forEachChild(node, visit);
    };
    visit(source);
    return out;
}

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return entry.name.endsWith(".ts") ? [full] : [];
    });
}

const files = sourceFiles(CORE_DIR);

test("the ACP core has source files to check", () => {
    assert.ok(files.length > 0);
});

test("the ACP core imports only its own files, the package core and contract, shared, and node", () => {
    assert.deepEqual(files.flatMap((file) => scan(file).imports), []);
});

test("the ACP core names no agent and no engine generation in its strings", () => {
    assert.deepEqual(files.flatMap((file) => scan(file).literals), []);
});

test("the ACP core names no agent in its identifiers", () => {
    assert.deepEqual(files.flatMap((file) => scan(file).names), []);
});

test("the ACP core reads no environment variables", () => {
    assert.deepEqual(files.flatMap((file) => scan(file).env), []);
});
