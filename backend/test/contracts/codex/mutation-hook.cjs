// Opt-in, process-local AST mutations. Never rewrites shared workspace files.
const { readFileSync } = require('node:fs');
const ts = require('typescript');

const mutation = process.env.MICHI_CODEX_CONTRACT_MUTATION;
const targets = {
  'compact-spelling': 'codexEventTranslator',
  'declined-as-completed': 'codexEventTranslator',
  'question-label-as-id': 'CodexSession',
};
if (!targets[mutation]) throw new Error(`Unknown contract mutation: ${mutation}`);
// The file the tests load through the package path, wherever the adapter lives.
const target = require.resolve(`michi-runtime/internal/adapters/codex/${targets[mutation]}`);
const original = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  if (filename !== target) return original(module, filename);
  let changes = 0;
  const transformer = (context) => {
    const visit = (node) => {
      if (ts.isStringLiteral(node)) {
        if (mutation === 'compact-spelling' && node.text === 'contextCompaction') {
          changes++;
          return ts.factory.createStringLiteral('contextCompacton');
        }
        if (mutation === 'declined-as-completed' && node.text === 'declined') {
          changes++;
          return ts.factory.createStringLiteral('completed');
        }
      }
      if (mutation === 'question-label-as-id' && ts.isPropertyAccessExpression(node)
        && node.name.text === 'id' && ts.isElementAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'matches') {
        changes++;
        return ts.factory.updatePropertyAccessExpression(node, node.expression, 'question');
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (source) => ts.visitNode(source, visit);
  };
  const result = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    transformers: { before: [transformer] },
  });
  if (!changes) throw new Error(`Mutation target no longer matches: ${mutation}`);
  module._compile(result.outputText, filename);
};
