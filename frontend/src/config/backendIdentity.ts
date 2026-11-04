// Remote entities have connection-scoped renderer identities. Servers only see
// their original IDs; losing UI metadata can never turn a remote ID into Local.
const PREFIX = 'remote:';

export function remoteEntityIdentity(id: string): { connectionId: string; id: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const separator = id.indexOf(':', PREFIX.length);
  if (separator < 0) throw new Error('Malformed remote entity identity');
  const connectionId = decodeURIComponent(id.slice(PREFIX.length, separator));
  const serverId = decodeURIComponent(id.slice(separator + 1));
  if (!connectionId || connectionId === 'local' || !serverId) throw new Error('Malformed remote entity identity');
  return { connectionId, id: serverId };
}

export function backendEntityId(connectionId: string, id: string): string {
  if (!id || connectionId === 'local') return id;
  const existing = remoteEntityIdentity(id);
  if (existing) {
    if (existing.connectionId !== connectionId) throw new Error('Entity belongs to a different backend connection');
    return id;
  }
  return `${PREFIX}${encodeURIComponent(connectionId)}:${encodeURIComponent(id)}`;
}

export function serverEntityId(id: string, connectionId?: string): string {
  const identity = remoteEntityIdentity(id);
  if (!identity) return id;
  if (connectionId !== undefined && identity.connectionId !== connectionId) {
    throw new Error('Entity belongs to a different backend connection');
  }
  return identity.id;
}

export function connectionIdFromApiUrl(url: string): string {
  const match = /\/backend-connections\/([^/]+)\/proxy(?:\/|\?|$)/.exec(url);
  return match ? decodeURIComponent(match[1]) : 'local';
}

const entityFields = new Set([
  'workspaceId', 'workspace_id', 'projectId', 'nodeId', 'node_id', 'chatId', 'pageId', 'page_id',
  'parentNodeId', 'parent_node_id', 'parentChatId', 'rootNodeId', 'root_node_id',
  'sourceNodeId', 'source_node_id', 'targetNodeId', 'target_node_id', 'origin_node_id',
  'forkedFromNodeId', 'forked_from_node_id',
  'fromWorkspaceId', 'toWorkspaceId', 'sourceWorkspaceId',
  'treeId', 'tree_id', 'activeTreeId', 'active_tree_id', 'sourceTreeId', 'targetTreeId', 'fromNodeId',
]);
const entityArrays = new Set(['nodeIds', 'chatIds', 'treeIds', 'childrenIds', 'mergeSources', 'digestSources']);
const encodedFields = new Set(['blocks', 'digest', 'composer_draft', 'metadata', 'trim_snapshot']);
const entityRoutes = new Set(['workspaces', 'trees', 'nodes', 'chats', 'files', 'artifacts']);
/** Objects keyed by entity ID, e.g. the liveness feed's `backgroundSubagents.nodes` (node id → agent ids). */
const entityKeyedContexts = new Set(['cursors', 'sourceFingerprints', 'backgroundSubagentNodes']);

function childContext(context: string, key: string): string {
  if (context === 'digest' && key === 'sources') return 'digestSources';
  if (context === 'backgroundSubagents' && key === 'nodes') return 'backgroundSubagentNodes';
  return key;
}

/** Translate structural references only; prose, paths and native session IDs stay opaque. */
export function mapBackendPayload<T>(value: T, connectionId: string, direction: 'renderer' | 'server', context = ''): T {
  const mapId = (id: string) => direction === 'renderer'
    ? backendEntityId(connectionId, id) : serverEntityId(id, connectionId);
  const mapPaneId = (id: string) => id.startsWith('node:') ? `node:${mapId(id.slice(5))}` : id;
  if (Array.isArray(value)) {
    return value.map(item => typeof item === 'string' && entityArrays.has(context)
      ? mapId(item) : typeof item === 'string' && context === 'paneIds'
        ? mapPaneId(item) : mapBackendPayload(item, connectionId, direction, context)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  const entityRow = ['workspace', 'workspaces', 'node', 'nodes', 'tree', 'trees'].includes(context);
  return Object.fromEntries(Object.entries(row).map(([key, item]) => {
    const mappedKey = entityKeyedContexts.has(context) ? mapId(key) : key;
    if (typeof item === 'string') {
      if (key === 'paneId') return [mappedKey, mapPaneId(item)];
      if (entityFields.has(key) || (key === 'id' && (entityRow || direction === 'server'))
        || (key === 'parentId' && (context === 'trim_snapshot' || context === 'trimSnapshot'))
        || (key === 'refId' && row.kind === 'node')) return [mappedKey, mapId(item)];
      if (encodedFields.has(key) || context === '__michiWindowDrafts') {
        let parsed: unknown;
        try { parsed = JSON.parse(item); } catch { return [mappedKey, item]; }
        return [mappedKey, JSON.stringify(mapBackendPayload(parsed, connectionId, direction, key))];
      }
    }
    return [mappedKey, mapBackendPayload(item, connectionId, direction, childContext(context, key))];
  })) as T;
}

/** URLs are also used directly by image elements and XMLHttpRequest. */
export function backendRequestUrl(input: string): string {
  const connectionId = connectionIdFromApiUrl(input);
  const [path, query] = input.split('?');
  const mappedPath = path.split('/').map((part, index, parts) => {
    if (!entityRoutes.has(parts[index - 1])) return part;
    const decoded = decodeURIComponent(part);
    return decoded.startsWith(PREFIX) ? encodeURIComponent(serverEntityId(decoded, connectionId)) : part;
  }).join('/');
  if (query === undefined) return mappedPath;
  const params = new URLSearchParams(query);
  let changed = false;
  for (const [key, value] of params) {
    if (entityFields.has(key) && value.startsWith(PREFIX)) { params.set(key, serverEntityId(value, connectionId)); changed = true; }
    else if (key === 'paneId' && value.startsWith('node:remote:')) {
      params.set(key, `node:${serverEntityId(value.slice(5), connectionId)}`); changed = true;
    } else if (key === 'cursors' || key === 'executionRef') {
      const mapped = JSON.stringify(mapBackendPayload({ [key]: JSON.parse(value) }, connectionId, 'server')[key]);
      if (mapped !== value) { params.set(key, mapped); changed = true; }
    }
  }
  return `${mappedPath}?${changed ? params : query}`;
}
