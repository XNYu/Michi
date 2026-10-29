import { DomainError } from './domainErrors';
import type { EnsureDurableGraphNodeInput } from './graphCommandTypes';

function invalid(message: string): never {
  throw new DomainError('invalid_argument', 'invalid_graph_prerequisite', message);
}

export function requiredGraphId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    invalid(`${label} must be a non-empty id <=160 chars`);
  }
  return value.trim();
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function optionalStrings(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of keys) {
    if (value[key] != null && typeof value[key] !== 'string') invalid(`${label}.${key} must be a string or null`);
  }
}

function numbers(value: Record<string, unknown>, keys: readonly string[], label: string, optional = false): void {
  for (const key of keys) {
    if (optional && value[key] == null) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) invalid(`${label}.${key} must be a finite number`);
  }
}

/** Validate the HTTP/worker boundary before a transaction can write anything. */
export function assertGraphNodeInput(input: unknown): asserts input is EnsureDurableGraphNodeInput {
  const value = object(input, 'graph prerequisite');
  const workspace = object(value.workspace, 'workspace');
  const node = object(value.node, 'node');
  requiredGraphId(workspace.id, 'workspace.id');
  requiredGraphId(node.id, 'node.id');
  if (typeof workspace.name !== 'string') invalid('workspace.name must be a string');
  numbers(workspace, ['createdAt'], 'workspace');
  numbers(node, ['createdAt'], 'node');
  optionalStrings(workspace, ['cwd', 'activeTreeId'], 'workspace');
  if (workspace.settings != null) object(workspace.settings, 'workspace.settings');
  optionalStrings(node, ['treeId', 'parentNodeId', 'kind', 'title', 'composerDraft', 'currentModeId'], 'node');
  for (const key of ['treeId', 'parentNodeId']) {
    if (node[key] != null) requiredGraphId(node[key], `node.${key}`);
  }
  if (node.spawnedByAgent !== undefined && typeof node.spawnedByAgent !== 'boolean') invalid('node.spawnedByAgent must be boolean');
  if (value.tree != null) {
    const tree = object(value.tree, 'tree');
    requiredGraphId(tree.id, 'tree.id');
    requiredGraphId(tree.rootNodeId, 'tree.rootNodeId');
    optionalStrings(tree, ['name'], 'tree');
    numbers(tree, ['createdAt', 'lastActiveAt'], 'tree');
    numbers(tree, ['archivedAt', 'pinnedAt'], 'tree', true);
  }
  if (!Array.isArray(value.edges)) invalid('edges must be an array');
  for (const rawEdge of value.edges) {
    const edge = object(rawEdge, 'edge');
    for (const key of ['id', 'sourceNodeId', 'targetNodeId', 'kind']) requiredGraphId(edge[key], `edge.${key}`);
    optionalStrings(edge, ['anchorMessageId'], 'edge');
    numbers(edge, ['createdAt'], 'edge', true);
  }
}
