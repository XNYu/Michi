import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv, { type ValidateFunction } from 'ajv';
import ts from 'typescript';

export const baselineDir = process.env.MICHI_CODEX_CONTRACT_BASELINE
  ? path.resolve(process.env.MICHI_CODEX_CONTRACT_BASELINE)
  : path.join(__dirname, 'baseline');
export const schema = JSON.parse(readFileSync(path.join(baselineDir, 'protocol.schema.json'), 'utf8'));
export const manifest = JSON.parse(readFileSync(path.join(baselineDir, 'manifest.json'), 'utf8'));

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
// Schemars uses Rust numeric formats in addition to JSON Schema's integer type.
for (const format of ['int32', 'int64', 'uint', 'uint32', 'uint64', 'uint8', 'uint16']) {
  ajv.addFormat(format, { type: 'number', validate: (value) => Number.isSafeInteger(value) && (!format.startsWith('u') || value >= 0) });
}
ajv.addSchema(schema, 'codex');
const validators = new Map<string, ValidateFunction>();
export function validator(name: string): ValidateFunction {
  const pointer = name.startsWith('v2/') ? name : Object.prototype.hasOwnProperty.call(schema.definitions, name) ? name : `v2/${name}`;
  let validate = validators.get(pointer);
  if (!validate) {
    validate = ajv.compile({ $ref: `codex#/definitions/${pointer}` });
    validators.set(pointer, validate);
  }
  return validate;
}
export function assertSchema(name: string, value: unknown): void {
  const validate = validator(name);
  assert.ok(validate(value), `${name}: ${ajv.errorsText(validate.errors, { separator: '\n' })}`);
}
export function discriminants(name: string, key: string): string[] {
  const definition = schema.definitions[name] ?? schema.definitions.v2[name];
  return definition.oneOf.map((branch: any) => {
    const values = branch.properties?.[key]?.enum;
    assert.equal(values?.length, 1, `${name}: unrecognized discriminant schema; review the extractor`);
    return values[0] as string;
  });
}
export function tsDiscriminants(name: string, key: string): string[] {
  const source = ts.createSourceFile(`${name}.ts`, readFileSync(path.join(baselineDir, `${name}.ts.txt`), 'utf8'), ts.ScriptTarget.Latest, true);
  const alias = source.statements.find((node): node is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  assert.ok(alias && ts.isUnionTypeNode(alias.type), `${name}: missing official TS union`);
  return alias.type.types.map((branch) => {
    const parts = ts.isIntersectionTypeNode(branch) ? branch.types : [branch];
    for (const part of parts) {
      if (!ts.isTypeLiteralNode(part)) continue;
      for (const member of part.members) {
        if (ts.isPropertySignature(member) && member.name && (ts.isStringLiteral(member.name) || ts.isIdentifier(member.name))
          && member.name.text === key && member.type && ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) {
          return member.type.literal.text;
        }
      }
    }
    throw new Error(`${name}: unrecognized TS discriminant; review the extractor`);
  });
}

export function variableStringLiterals(file: string, name: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) values.push(node.text);
    ts.forEachChild(node, collect);
  };
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) collect(node.initializer);
    else ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(values.length, `Missing protocol constant ${name}; update its contract check`);
  return values;
}
