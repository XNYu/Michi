import {
  MICHI_DB_COLUMN_TYPES,
  MICHI_DB_FILTER_OPS,
  MICHI_DB_LIMITS,
  MICHI_DB_VIEW_TYPES,
  type MichiDbCellValue,
  type MichiDbColumn,
  type MichiDbColumnOption,
  type MichiDbNewColumn,
  type MichiDbRow,
  type MichiDbView,
  type MichiDbViewType,
} from '../databaseModel';
import { validatePageComponentProps } from './components';

export type PageDatabaseColumn = Omit<MichiDbColumn, 'builtin'>;
export type PageDatabaseView = Omit<MichiDbView, 'type' | 'config'> & {
  /** Every Michi view: table, board, list, calendar, gallery, timeline, or custom (a library component). */
  type: MichiDbViewType;
  config: MichiDbView['config'] & { componentId?: string; pinnedVersion?: number; props?: Record<string, unknown>; height?: number };
  /** Server-owned timestamp set only when a person explicitly saves this view. */
  edit?: { at: number };
};
export type PageDatabaseNewView = Omit<PageDatabaseView, 'id' | 'position'> & { id?: string };
export type PageDatabaseRow = Omit<MichiDbRow, 'body'> & {
  body?: string;
  rev: number;
  edited: Record<string, number>;
  bodyEditedAt: number | null;
};
/** `tasks`: the workspace's task database (see tasks.ts). */
export type PageDatabaseRole = 'tasks';
export interface PageDatabase {
  id: string;
  workspaceId: string;
  role?: PageDatabaseRole;
  title: string;
  columns: PageDatabaseColumn[];
  views: PageDatabaseView[];
  rows: PageDatabaseRow[];
  revision: number;
  updatedAt: number;
}

type UserOp =
  | { op: 'column.add'; column: MichiDbNewColumn; after?: string | null }
  | { op: 'column.update'; id: string; patch: Partial<Omit<MichiDbColumn, 'id' | 'builtin'>> }
  | { op: 'column.delete'; id: string }
  | { op: 'column.move'; id: string; after: string | null }
  | { op: 'option.add'; id: string; option: MichiDbColumnOption }
  | { op: 'row.add'; id?: string; values: Record<string, MichiDbCellValue>; body?: string; after?: string | null }
  | { op: 'row.update'; id: string; values?: Record<string, MichiDbCellValue>; body?: string; expectRev?: number }
  | { op: 'row.delete'; id: string; expectRev?: number }
  | { op: 'row.move'; id: string; after: string | null }
  | { op: 'view.save'; view: PageDatabaseNewView }
  | { op: 'view.delete'; id: string };
type AgentOp =
  | { op: 'row.add'; id?: string; values: Record<string, MichiDbCellValue>; body?: string; after?: string | null }
  | { op: 'row.update'; id: string; values?: Record<string, MichiDbCellValue>; body?: string; expectRev: number }
  | { op: 'row.delete'; id: string; expectRev: number };
export type PageDatabaseEditOp = UserOp | AgentOp;

export type PageDatabaseParseResult =
  | { ok: true; ops: PageDatabaseEditOp[] }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const ownKeys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const text = (value: unknown, max = 2000) => typeof value === 'string' && value.length <= max;
const COLUMN_TYPES: readonly string[] = MICHI_DB_COLUMN_TYPES;
const FILTER_OPS: readonly string[] = MICHI_DB_FILTER_OPS;
const validId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200;

function validCell(value: unknown, depth = 0): value is MichiDbCellValue {
  if (depth > 2) return false;
  if (value === null || typeof value === 'string') return value === null || value.length <= 2000;
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 50 && value.every((item) => typeof item === 'string' && item.length <= 200);
  if (isRecord(value)) return ownKeys(value, ['start', 'end']) && text(value.start, 100)
    && (value.end === undefined || text(value.end, 100));
  return false;
}
function validValues(value: unknown): value is Record<string, MichiDbCellValue> {
  return isRecord(value) && Object.keys(value).length <= MICHI_DB_LIMITS.columns
    && Object.entries(value).every(([key, cell]) => validId(key) && validCell(cell));
}
function validColumn(value: unknown): value is MichiDbNewColumn {
  if (!isRecord(value) || !ownKeys(value, ['id', 'name', 'type', 'options', 'editable', 'width'])) return false;
  if (value.id !== undefined && !validId(value.id)) return false;
  if (!text(value.name, 100) || !COLUMN_TYPES.includes(String(value.type))) return false;
  if (value.editable !== undefined && typeof value.editable !== 'boolean') return false;
  if (value.width !== undefined && (typeof value.width !== 'number' || !Number.isFinite(value.width) || value.width < 40 || value.width > 1000)) return false;
  return value.options === undefined || (Array.isArray(value.options) && value.options.length <= 100
    && value.options.every((option) => isRecord(option) && ownKeys(option, ['value','label','color']) && text(option.value, 200)
      && (option.label === undefined || text(option.label, 200))
      && (option.color === undefined || ['gray','blue','green','amber','red','violet'].includes(String(option.color)))
      ) && new Set(value.options.map((option) => option.value)).size === value.options.length);
}
function validView(value: unknown): value is PageDatabaseNewView {
  if (!isRecord(value) || !ownKeys(value, ['id','name','type','config'])) return false;
  if (value.id !== undefined && !validId(value.id)) return false;
  if (!text(value.name, 100) || !(MICHI_DB_VIEW_TYPES as readonly string[]).includes(String(value.type)) || !isRecord(value.config)) return false;
  const c = value.config;
  const custom = value.type === 'custom';
  if (!ownKeys(c, custom ? ['filters','match','sorts','group','visible','date','planDate','cover','componentId','pinnedVersion','props','height'] : ['filters','match','sorts','group','visible','date','planDate','cover'])) return false;
  if (!Array.isArray(c.filters) || c.filters.length > 100 || !Array.isArray(c.sorts) || c.sorts.length > 100 || !['all','any'].includes(String(c.match))) return false;
  if (c.filters.some((f) => !isRecord(f) || !ownKeys(f, ['column','op','value']) || !validId(f.column) || !FILTER_OPS.includes(String(f.op)) || (f.value !== undefined && !validCell(f.value)))) return false;
  if (c.sorts.some((x) => !isRecord(x) || !ownKeys(x, ['column','dir']) || !validId(x.column) || !['asc','desc'].includes(String(x.dir)))) return false;
  if (c.visible !== undefined && (!Array.isArray(c.visible) || c.visible.length > 100 || !c.visible.every(validId))) return false;
  for (const key of ['group','date','planDate','cover']) if (c[key] !== undefined && !validId(c[key])) return false;
  if (custom && (!validId(c.componentId) || (c.pinnedVersion !== undefined && (!Number.isSafeInteger(c.pinnedVersion) || (c.pinnedVersion as number) < 1)) ||
    (c.height !== undefined && (!Number.isSafeInteger(c.height) || (c.height as number) < 80 || (c.height as number) > 1600)) || validatePageComponentProps(null, c.props) === null)) return false;
  return true;
}

const EDIT_OPS = new Set(['column.add','column.update','column.delete','column.move','option.add','row.add','row.update','row.delete','row.move','view.save','view.delete']);
const keysByOp: Record<string, readonly string[]> = {
  'column.add':['op','column','after'], 'column.update':['op','id','patch'], 'column.delete':['op','id'], 'column.move':['op','id','after'],
  'option.add':['op','id','option'], 'row.add':['op','id','values','body','after'],
  'row.update':['op','id','values','body','expectRev'], 'row.delete':['op','id','expectRev'], 'row.move':['op','id','after'],
  'view.save':['op','view'], 'view.delete':['op','id'],
};
/** Strictly parse native database edits. Payloads are bounded before detailed validation. */
export function parsePageDatabaseOps(input: unknown, actor: 'user' | 'agent'): PageDatabaseParseResult {
  if (!Array.isArray(input) || input.length > MICHI_DB_LIMITS.editOps) return { ok: false, error: 'invalid operation batch size' };
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(input)).length; } catch { return { ok: false, error: 'invalid operation payload' }; }
  if (bytes > MICHI_DB_LIMITS.editBytes) return { ok: false, error: 'operation payload too large' };
  const ops: PageDatabaseEditOp[] = [];
  const suppliedIds = new Set<string>();
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.op !== 'string' || !EDIT_OPS.has(raw.op) || !ownKeys(raw, keysByOp[raw.op]!)) return { ok: false, error: 'invalid operation shape' };
    if (actor === 'agent' && !['row.add','row.update','row.delete'].includes(raw.op)) return { ok: false, error: 'agents may only edit rows' };
    if (raw.op === 'column.add' && (!validColumn(raw.column) || (raw.after !== undefined && raw.after !== null && !validId(raw.after)))) return { ok: false, error: 'invalid column' };
    if (raw.op === 'column.update' && (!validId(raw.id) || !isRecord(raw.patch) || !ownKeys(raw.patch, ['name','type','options','editable','width']) || (raw.patch.name !== undefined && !text(raw.patch.name,100)) || (raw.patch.type !== undefined && !COLUMN_TYPES.includes(String(raw.patch.type))) || (raw.patch.editable !== undefined && typeof raw.patch.editable !== 'boolean') || (raw.patch.width !== undefined && (typeof raw.patch.width !== 'number' || !Number.isFinite(raw.patch.width) || raw.patch.width < 40 || raw.patch.width > 1000)) || (raw.patch.options !== undefined && !validColumn({name:'x',type:'text',options:raw.patch.options})))) return { ok: false, error: 'invalid column update' };
    if (raw.op === 'column.delete' && !validId(raw.id)) return { ok: false, error: 'invalid column id' };
    if (raw.op === 'column.move' && (!validId(raw.id) || (raw.after !== null && !validId(raw.after)))) return { ok: false, error: 'invalid column move' };
    if (raw.op === 'option.add' && (!validId(raw.id) || !isRecord(raw.option) || !ownKeys(raw.option, ['value','label','color']) || !text(raw.option.value,200) || (raw.option.label !== undefined && !text(raw.option.label,200)) || (raw.option.color !== undefined && !['gray','blue','green','amber','red','violet'].includes(String(raw.option.color))))) return { ok: false, error: 'invalid option' };
    if (raw.op === 'view.save' && !validView(raw.view)) return { ok: false, error: 'invalid view' };
    if (raw.op === 'view.delete' && !validId(raw.id)) return { ok: false, error: 'invalid view id' };
    if (raw.op.startsWith('row.')) {
      if (raw.op === 'row.add') {
        if ((raw.id !== undefined && !validId(raw.id)) || !validValues(raw.values) || (raw.body !== undefined && !text(raw.body, 100_000)) || (raw.after !== undefined && raw.after !== null && !validId(raw.after))) return { ok: false, error: 'invalid row' };
      } else if (!validId(raw.id)) return { ok: false, error: 'invalid row id' };
      if (raw.op === 'row.update' && ((raw.values !== undefined && !validValues(raw.values)) || (raw.body !== undefined && !text(raw.body,100_000)) || (raw.values === undefined && raw.body === undefined))) return { ok: false, error: 'invalid row update' };
      if ((raw.op === 'row.move' && raw.after !== null && !validId(raw.after)) || (raw.op === 'row.add' && raw.after !== undefined && raw.after !== null && !validId(raw.after))) return { ok: false, error: 'invalid row position' };
      if ((raw.op === 'row.update' || raw.op === 'row.delete') && raw.expectRev !== undefined && (!Number.isSafeInteger(raw.expectRev) || (raw.expectRev as number) < 1)) return { ok: false, error: 'invalid expected revision' };
      if (actor === 'agent' && (raw.op === 'row.update' || raw.op === 'row.delete') && raw.expectRev === undefined) return { ok: false, error: 'expectRev is required for agent row edits' };
      if (raw.op === 'row.move' && actor === 'agent') return { ok: false, error: 'agents may only add, update, or delete rows' };
    }
    const suppliedId = raw.op === 'column.add' && isRecord(raw.column) ? raw.column.id : raw.op === 'row.add' ? raw.id : raw.op === 'view.save' && isRecord(raw.view) ? raw.view.id : undefined;
    if (suppliedId !== undefined) {
      const scoped = `${raw.op.startsWith('column') ? 'column' : raw.op.startsWith('row') ? 'row' : 'view'}:${String(suppliedId)}`;
      if (suppliedIds.has(scoped)) return { ok: false, error: 'duplicate resource id in batch' };
      suppliedIds.add(scoped);
    }
    ops.push(raw as PageDatabaseEditOp);
  }
  return { ok: true, ops };
}

export interface ApplyPageDatabaseOptions {
  actor: 'user' | 'agent';
  revision: number;
  now: number;
  newId?: (prefix: 'col' | 'view' | 'row') => string;
}
export interface ApplyPageDatabaseResult {
  database: PageDatabase;
  changed: boolean;
  touchedRows: string[];
  deletedRows: string[];
  rejectedOps: Array<{ index: number; reason: 'target_missing' | 'revision_conflict' }>;
}

const moveAfter = <T extends { id:string }>(list:T[], id:string, after:string|null): T[] => {
  const item=list.find((x)=>x.id===id); if (!item || id===after) return list;
  const rest=list.filter((x)=>x.id!==id);
  const afterIndex=after===null?-1:rest.findIndex((x)=>x.id===after); if (after!==null&&afterIndex<0) return list;
  rest.splice(afterIndex+1,0,item); return rest;
};
/** Apply an already validated batch as one immutable native database update. */
export function applyPageDatabaseOps(database: PageDatabase, ops: readonly PageDatabaseEditOp[], options: ApplyPageDatabaseOptions): ApplyPageDatabaseResult {
  if(!Number.isSafeInteger(options.revision)||options.revision<=database.revision||!Number.isFinite(options.now))throw new Error('invalid next database revision or timestamp');
  const parsed = parsePageDatabaseOps(ops, options.actor);
  if (!parsed.ok) throw new Error(parsed.error);
  let columns: PageDatabaseColumn[] = database.columns.map((x): PageDatabaseColumn => ({...x,options:x.options?.map((o)=>({...o}))}));
  let views = database.views.map((x)=>({...x,config:{...x.config,filters:x.config.filters.map((f)=>({...f})),sorts:x.config.sorts.map((s)=>({...s}))}}));
  let rows = database.rows.map((x)=>({...x,values:{...x.values},edited:{...x.edited}}));
  const touchedRows = new Set<string>(); const deletedRows = new Set<string>(); const rejectedOps: ApplyPageDatabaseResult['rejectedOps'] = [];
  const id=(prefix:'col'|'view'|'row')=>{if(!options.newId)throw new Error('newId is required when adding a database resource');return options.newId(prefix);};
  let applied = false;
  const failOrReject = (opIndex: number, reason: 'target_missing' | 'revision_conflict'): boolean => {
    if (options.actor === 'user') throw new Error(`${reason} at operation ${opIndex}`);
    rejectedOps.push({ index: opIndex, reason });
    return true;
  };
  for (let opIndex=0; opIndex<ops.length; opIndex+=1) {
    const op=ops[opIndex]!;
    if (op.op==='column.add') {
      const columnId=op.column.id??id('col');
      if(columns.some((c)=>c.id===columnId)) throw new Error(`duplicate column id: ${columnId}`);
      const col={...op.column,id:columnId} as PageDatabaseColumn;
      const at=op.after===undefined?columns.length:op.after===null?0:columns.findIndex((c)=>c.id===op.after)+1;
      if(op.after!=null&&at===0) throw new Error(`column anchor missing: ${op.after}`);
      columns.splice(at,0,col); applied=true;
    }
    else if (op.op==='column.update') {
      if(!columns.some((c)=>c.id===op.id)) failOrReject(opIndex,'target_missing');
      else { columns=columns.map((c)=>c.id===op.id?({...c,...op.patch}):c); applied=true; }
    }
    else if (op.op==='column.delete') {
      if(!columns.some((c)=>c.id===op.id)){failOrReject(opIndex,'target_missing');continue;}
      columns=columns.filter((c)=>c.id!==op.id);
      rows=rows.map((r)=>{if(!(op.id in r.values)&&!(op.id in r.edited))return r;const values={...r.values},edited={...r.edited};delete values[op.id];delete edited[op.id];touchedRows.add(r.id);return {...r,values,edited,updatedAt:options.now,rev:options.revision};}); applied=true;
      // A deleted column cannot remain in any saved view config. Board views
      // fall back to the first remaining select column in effectiveConfig().
      views=views.map((view)=>{
        const config={...view.config,
          filters:view.config.filters.filter((filter)=>filter.column!==op.id),
          sorts:view.config.sorts.filter((sort)=>sort.column!==op.id),
          ...(view.config.visible===undefined?{}:{visible:view.config.visible.filter((columnId)=>columnId!==op.id)}),
        };
        for(const key of ['group','date','planDate','cover'] as const)if(config[key]===op.id)delete config[key];
        return {...view,config};
      });
    }
    else if (op.op==='column.move') { if(!columns.some((c)=>c.id===op.id))throw new Error(`column target missing: ${op.id}`); if(op.after!==null&&!columns.some((c)=>c.id===op.after))throw new Error(`column anchor missing: ${op.after}`); const moved=moveAfter(columns,op.id,op.after); applied ||= moved!==columns; columns=moved; }
    else if (op.op==='option.add') {
      if(!columns.some((c)=>c.id===op.id)){failOrReject(opIndex,'target_missing');continue;}
      const column=columns.find((c)=>c.id===op.id)!;
      if((column.options??[]).some((o)=>o.value===op.option.value)) throw new Error(`duplicate option value: ${op.option.value}`);
      columns=columns.map((c)=>c.id===op.id?({...c,options:[...(c.options??[]),op.option]}):c);applied=true;
    }
    else if (op.op==='view.save') {
      const viewId=op.view.id??id('view'); if(views.some((v)=>v.id===viewId)&&op.view.id===undefined)throw new Error(`duplicate view id: ${viewId}`);
      const at=views.findIndex((x)=>x.id===viewId); const v={...op.view,id:viewId,position:at<0?views.length:views[at]!.position,
        ...(options.actor==='user'?{edit:{at:options.now}}:at<0?{}:views[at]!.edit?{edit:views[at]!.edit}:{})} as PageDatabaseView; if(at<0)views.push(v);else views[at]=v; applied=true;
    }
    else if (op.op==='view.delete') { if(!views.some((v)=>v.id===op.id)){failOrReject(opIndex,'target_missing');continue;} views=views.filter((v)=>v.id!==op.id);applied=true; }
    else if (op.op==='row.add') {
      const rid=op.id??id('row'); if(rows.some((r)=>r.id===rid))throw new Error(`duplicate row id: ${rid}`);
      if(op.after!=null&&!rows.some((r)=>r.id===op.after))throw new Error(`row anchor missing: ${op.after}`);
      const columnIds=new Set(columns.map((c)=>c.id)); if(Object.keys(op.values).some((key)=>!columnIds.has(key)))throw new Error('row contains an unknown column id');
      const row:PageDatabaseRow={id:rid,values:{...op.values},...(op.body===undefined?{}:{body:op.body}),position:rows.reduce((top,r)=>Math.max(top,r.position+1),0),updatedAt:options.now,rev:options.revision,edited:{},bodyEditedAt:null};
      if(options.actor==='user'){row.edited=Object.fromEntries(Object.keys(op.values).map((key)=>[key,options.now]));if(op.body!==undefined)row.bodyEditedAt=options.now;}
      rows.push(row); if(op.after!==undefined){const moved=moveAfter(rows,rid,op.after);rows=moved.map((r,index)=>{if(r.id===rid)return {...r,position:index};const prev=rows.find((x)=>x.id===r.id)!;if(prev.position===index)return prev;touchedRows.add(r.id);return {...r,position:index,updatedAt:options.now,rev:options.revision};});} touchedRows.add(rid); applied=true;
    }
    else if (op.op==='row.update') {
      const index=rows.findIndex((r)=>r.id===op.id); if(index<0){failOrReject(opIndex,'target_missing');continue;}
      const prev=rows[index]!; if(op.expectRev!==undefined&&prev.rev!==op.expectRev){failOrReject(opIndex,'revision_conflict');continue;}
      const columnIds=new Set(columns.map((c)=>c.id)); if(Object.keys(op.values??{}).some((key)=>!columnIds.has(key)))throw new Error('row contains an unknown column id');
      const changedValues:Record<string,MichiDbCellValue>={}; const edited={...prev.edited};
      for(const [key,value] of Object.entries(op.values??{})){
        const valueChanged=JSON.stringify(prev.values[key]??null)!==JSON.stringify(value??null);
        if(valueChanged)changedValues[key]=value;
        // A same-value save is still meaningful when it establishes human
        // ownership for a field that was previously agent-owned or unowned.
        if(options.actor==='user'&&prev.edited[key]===undefined)edited[key]=options.now;
      }
      const bodyChanged=op.body!==undefined&&(prev.body??'')!==op.body;
      const bodyOwnershipChanged=options.actor==='user'&&op.body!==undefined&&prev.bodyEditedAt===null;
      if(!Object.keys(changedValues).length&&!bodyChanged&&!bodyOwnershipChanged&&
        !(options.actor==='user'&&Object.keys(op.values??{}).some((key)=>prev.edited[key]===undefined)))continue;
      rows[index]={...prev,values:Object.keys(changedValues).length?{...prev.values,...changedValues}:prev.values,
        ...(bodyChanged?{body:op.body}:{}),updatedAt:options.now,rev:options.revision,edited,
        bodyEditedAt:bodyOwnershipChanged?options.now:prev.bodyEditedAt};
      touchedRows.add(op.id); applied=true;
    }
    else if (op.op==='row.delete') { const row=rows.find((r)=>r.id===op.id); if(!row){failOrReject(opIndex,'target_missing');continue;} if(op.expectRev!==undefined&&row.rev!==op.expectRev){failOrReject(opIndex,'revision_conflict');continue;} rows=rows.filter((r)=>r.id!==op.id);deletedRows.add(op.id); applied=true; }
    else if (op.op==='row.move') { if(!rows.some((r)=>r.id===op.id)){failOrReject(opIndex,'target_missing');continue;} if(op.after!==null&&!rows.some((r)=>r.id===op.after))throw new Error(`row anchor missing: ${op.after}`); const moved=moveAfter(rows,op.id,op.after); rows=moved.map((r,index)=>{const prev=rows.find((x)=>x.id===r.id)!; if(prev.position===index)return prev; touchedRows.add(r.id); applied=true; return {...r,position:index,updatedAt:options.now,rev:options.revision};}); }
  }
  if(columns.length>MICHI_DB_LIMITS.columns||views.length>MICHI_DB_LIMITS.views||rows.length>MICHI_DB_LIMITS.rows)throw new Error('database resource limit exceeded');
  const unique=(ids:string[])=>new Set(ids).size===ids.length;
  if(!unique(columns.map((x)=>x.id))||!unique(views.map((x)=>x.id))||!unique(rows.map((x)=>x.id)))throw new Error('duplicate resource id');
  if([...columns,...views,...rows].some((resource)=>!validId(resource.id)))throw new Error('invalid resource id');
  const columnIds=new Set(columns.map((c)=>c.id));
  for(const row of rows)if(Object.keys(row.values).some((key)=>!columnIds.has(key)))throw new Error(`row ${row.id} references an unknown column`);
  for(const view of views){const config=view.config;for(const id of [config.group,config.date,config.planDate,config.cover,...(config.visible??[]),...config.filters.map((f)=>f.column),...config.sorts.map((sort)=>sort.column)].filter((x):x is string=>x!==undefined))if(!columnIds.has(id))throw new Error(`view ${view.id} references an unknown column`);}
  const changed=applied && (JSON.stringify(columns)!==JSON.stringify(database.columns)||JSON.stringify(views)!==JSON.stringify(database.views)||JSON.stringify(rows)!==JSON.stringify(database.rows));
  return {database:changed?{...database,columns,views,rows,revision:options.revision,updatedAt:options.now}:database,changed,touchedRows:[...touchedRows],deletedRows:[...deletedRows],rejectedOps};
}
