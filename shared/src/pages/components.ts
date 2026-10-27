/** Browser-safe contracts and bounded validators for native page components. */
export const PAGE_COMPONENT_LIMITS = {
  name: 80, description: 500, codeBytes: 200_000, jsonBytes: 64_000, schemaDepth: 8,
  schemaProperties: 64, refsPerComponent: 2_000, propsBytes: 64_000, heightMin: 80, heightMax: 1_600, draftChars: 8_000,
} as const;

export interface PageComponentSource { kind: 'chat' | 'helper'; nodeId: string; turnId: string; assistantId: string }
/** A user actor is created only by authenticated native UI handlers, never accepted from agent tool input. */
export type PageComponentActor = PageComponentSource | { kind:'user' };
/** Strictly validated attribution persisted on an immutable component version. */
export type PageComponentVersionSource = PageComponentActor;
export interface PageComponentVersion {
  componentId: string; version: number; code: string; propsSchema: JsonSchema | null;
  source: PageComponentVersionSource; createdAt: number;
}
export interface PageComponent {
  id: string; ownerUserId: string; workspaceId: string; name: string; description: string;
  enabled: boolean; activeVersion: number; libraryRevision: number; revocationEpoch: number;
  deletedAt: number | null; versions: number; createdAt: number; updatedAt: number;
}
export interface PageComponentRecord extends PageComponent { current: PageComponentVersion }
export interface PageComponentInput { name: string; description: string; code: string; propsSchema?: unknown }
export interface PageComponentReference {
  componentId: string; workspaceId: string; kind: 'page_block' | 'database_view';
  pageId?: string; blockId?: string; databaseId?: string; viewId?: string;
  pinnedVersion: number | null; protected: boolean; hostRevision: number;
}
export interface PageComponentHostConfig { componentId: string; pinnedVersion?: number; props: Record<string, unknown>; height?: number }
export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean;
  items?: JsonSchema; enum?: unknown[]; const?: unknown;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number;
};

export const isComponentRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && [...v].length <= max;
function jsonBytes(v: unknown): number | null {
  try { return new TextEncoder().encode(JSON.stringify(v)).length; } catch { return null; }
}
function jsonValue(v: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return typeof v !== 'string' || [...v].length <= PAGE_COMPONENT_LIMITS.propsBytes;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 2_000 && v.every(x => jsonValue(x, depth + 1));
  return isComponentRecord(v) && Object.keys(v).length <= PAGE_COMPONENT_LIMITS.schemaProperties && Object.entries(v).every(([k, x]) => k.length <= 200 && jsonValue(x, depth + 1));
}
function validSchema(v: unknown, depth = 0): v is JsonSchema {
  if (!isComponentRecord(v) || depth > PAGE_COMPONENT_LIMITS.schemaDepth) return false;
  const allowed = ['type','properties','required','additionalProperties','items','enum','const','minLength','maxLength','minimum','maximum','minItems','maxItems'];
  if (Object.keys(v).some(k => !allowed.includes(k))) return false;
  if (v.type !== undefined && !['object','array','string','number','integer','boolean','null'].includes(String(v.type))) return false;
  for (const k of ['minLength','maxLength','minItems','maxItems']) if (v[k] !== undefined && (!Number.isSafeInteger(v[k]) || (v[k] as number) < 0 || (v[k] as number) > 10_000)) return false;
  for (const k of ['minimum','maximum']) if (v[k] !== undefined && (typeof v[k] !== 'number' || !Number.isFinite(v[k]))) return false;
  if (v.additionalProperties !== undefined && typeof v.additionalProperties !== 'boolean') return false;
  if (v.required !== undefined && (!Array.isArray(v.required) || v.required.length > PAGE_COMPONENTS_PROPERTIES || !v.required.every(id) || new Set(v.required).size !== v.required.length)) return false;
  if (v.properties !== undefined && (!isComponentRecord(v.properties) || Object.keys(v.properties).length > PAGE_COMPONENT_LIMITS.schemaProperties || Object.entries(v.properties).some(([k, x]) => !id(k) || !validSchema(x, depth + 1)))) return false;
  if (v.items !== undefined && !validSchema(v.items, depth + 1)) return false;
  if (v.enum !== undefined && (!Array.isArray(v.enum) || v.enum.length > 100 || !v.enum.every(jsonValue))) return false;
  if (Object.prototype.hasOwnProperty.call(v, 'const') && !jsonValue(v.const)) return false;
  return true;
}
const PAGE_COMPONENTS_PROPERTIES = PAGE_COMPONENT_LIMITS.schemaProperties;
export function parsePageComponentPropsSchema(value: unknown): JsonSchema | null | undefined {
  if (value === undefined || value === null) return null;
  const bytes = jsonBytes(value);
  if (bytes === null || bytes > PAGE_COMPONENT_LIMITS.jsonBytes || !validSchema(value) || (value.type !== undefined && value.type !== 'object')) return undefined;
  return JSON.parse(JSON.stringify(value)) as JsonSchema;
}
function matches(v: unknown, s: JsonSchema, depth = 0): boolean {
  if (depth > PAGE_COMPONENT_LIMITS.schemaDepth) return false;
  if (s.const !== undefined && JSON.stringify(v) !== JSON.stringify(s.const)) return false;
  if (s.enum && !s.enum.some(x => JSON.stringify(x) === JSON.stringify(v))) return false;
  switch (s.type) {
    case 'object': if (!isComponentRecord(v)) return false; break;
    case 'array': if (!Array.isArray(v)) return false; break;
    case 'string': if (typeof v !== 'string') return false; break;
    case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) return false; break;
    case 'integer': if (!Number.isSafeInteger(v)) return false; break;
    case 'boolean': if (typeof v !== 'boolean') return false; break;
    case 'null': if (v !== null) return false; break;
  }
  if (typeof v === 'string' && ((s.minLength !== undefined && [...v].length < s.minLength) || (s.maxLength !== undefined && [...v].length > s.maxLength))) return false;
  if (typeof v === 'number' && ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) return false;
  if (Array.isArray(v)) return (s.minItems === undefined || v.length >= s.minItems) && (s.maxItems === undefined || v.length <= s.maxItems) && (!s.items || v.every(x => matches(x, s.items!, depth + 1)));
  if (isComponentRecord(v)) {
    if (s.required?.some(k => !Object.prototype.hasOwnProperty.call(v, k))) return false;
    if (s.additionalProperties === false && Object.keys(v).some(k => !Object.prototype.hasOwnProperty.call(s.properties ?? {}, k))) return false;
    return Object.entries(s.properties ?? {}).every(([k, sub]) => !Object.prototype.hasOwnProperty.call(v, k) || matches(v[k], sub, depth + 1));
  }
  return true;
}
export function validatePageComponentProps(schema: JsonSchema | null, value: unknown): Record<string, unknown> | null {
  if (!isComponentRecord(value) || !jsonValue(value)) return null;
  const bytes = jsonBytes(value);
  if (bytes === null || bytes > PAGE_COMPONENT_LIMITS.propsBytes || (schema !== null && !matches(value, schema))) return null;
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}
/** Parse component identity, optional immutable version pin, and bounded JSON props. */
export function parsePageComponentHostConfig(value: unknown): PageComponentHostConfig | null {
  if (!isComponentRecord(value) || Object.keys(value).some(k => !['componentId','pinnedVersion','props','height'].includes(k)) || !id(value.componentId) ||
    (value.pinnedVersion !== undefined && (!Number.isSafeInteger(value.pinnedVersion) || (value.pinnedVersion as number) < 1)) ||
    (value.height !== undefined && (!Number.isSafeInteger(value.height) || (value.height as number) < PAGE_COMPONENT_LIMITS.heightMin || (value.height as number) > PAGE_COMPONENT_LIMITS.heightMax))) return null;
  const props = validatePageComponentProps(null, value.props);
  return props === null ? null : { componentId: value.componentId as string,
    ...(value.pinnedVersion === undefined ? {} : { pinnedVersion: value.pinnedVersion as number }), props,
    ...(value.height === undefined ? {} : { height: value.height as number }) };
}
export function parsePageComponentInput(value: unknown): PageComponentInput | null {
  if (!isComponentRecord(value) || Object.keys(value).some(k => !['name','description','code','propsSchema'].includes(k))) return null;
  const { name, description, code } = value;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(name) || !text(description, PAGE_COMPONENT_LIMITS.description) || !description.trim() ||
    typeof code !== 'string' || !code.trim() || new TextEncoder().encode(code).length > PAGE_COMPONENT_LIMITS.codeBytes) return null;
  const propsSchema = parsePageComponentPropsSchema(value.propsSchema);
  if (propsSchema === undefined) return null;
  return { name, description: description.trim(), code, ...(value.propsSchema === undefined ? {} : { propsSchema }) };
}
export function parsePageComponentSource(value: unknown): PageComponentSource | null {
  if (!isComponentRecord(value) || Object.keys(value).some(k => !['kind','nodeId','turnId','assistantId'].includes(k)) ||
    (value.kind !== 'chat' && value.kind !== 'helper') || ![value.nodeId,value.turnId,value.assistantId].every(id)) return null;
  return value as unknown as PageComponentSource;
}
/** Tool source parsing deliberately excludes user actors; this parser is for stored version attribution. */
export function parsePageComponentVersionSource(value: unknown): PageComponentVersionSource | null {
  if (isComponentRecord(value) && value.kind === 'user' && Object.keys(value).length === 1) return { kind: 'user' };
  return parsePageComponentSource(value);
}
