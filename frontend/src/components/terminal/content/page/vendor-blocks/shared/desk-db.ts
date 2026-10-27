import {z} from 'zod';
import type {ThreadState} from './desk.ts';
import {CODE,codeFits} from './desk-catalog/fields.ts';
import {L} from './i18n.ts';
/** Spec §3: one model for the three kinds of database (the threads database, ones you make, tables on a project page). Pure, zod only:
 * the server persisting an edit and the client applying it optimistically, filtering and grouping it, have to reach the same answer. */
export const COLUMN_TYPES=['text','number','date','select','multi','checkbox','url','progress','app','image'] as const;
export const VIEW_TYPES=['table','board','list','calendar','gallery','timeline','custom'] as const;
export const FILTER_OPS=['is','is-not','contains','not-contains','empty','not-empty','gt','lt','before','after','checked','unchecked'] as const;
export const OPTION_COLORS=['gray','blue','green','amber','red','violet'] as const;
export type ColumnType=typeof COLUMN_TYPES[number];
/** `value` is what a cell stores and `label` what people see (value when absent): a thread stays `doing` while its badge says 推进中. */
export type ColumnOption={value:string;label?:string;color?:typeof OPTION_COLORS[number]};
export type Column={id:string;name:string;type:ColumnType;options?:ColumnOption[];builtin?:true;editable?:boolean;width?:number};
export type DateValue={start:string;end?:string};           // 'YYYY-MM-DD' 或 ISO 时间
export type CellValue=string|number|boolean|string[]|DateValue|null;
export type Row={id:string;values:Record<string,CellValue>;body?:string;position:number;updatedAt:number};
export type ViewType=typeof VIEW_TYPES[number];
export type FilterOp=typeof FILTER_OPS[number];
export type Filter={column:string;op:FilterOp;value?:CellValue};
export type ViewConfig={filters:Filter[];match:'all'|'any';sorts:{column:string;dir:'asc'|'desc'}[];group?:string;visible?:string[];
  date?:string;planDate?:string;cover?:string;component?:string;code?:string};   // timeline：date 是实际，planDate 是计划（可选）
export type View={id:string;name:string;type:ViewType;config:ViewConfig;position:number};
export type DbKind='threads'|'user'|'page';
export type Database={id:string;title:string;icon?:string;projectId?:string|null;kind:DbKind;columns:Column[];views:View[];rows:Row[];updatedAt:number};
/** `key` is what dropping a card on the group writes back as the cell: the option value, 'true'/'false' for a checkbox, null for 未填.
 * An ungrouped view is one group with key null and an empty label. */
export type Group={key:string|null;label:string;rows:Row[];count:number;sums:Record<string,number>};
export type DbEditOp=
 |{op:'column.add';column:Omit<Column,'id'|'builtin'>&{id?:string};after?:string|null}
 |{op:'column.update';id:string;patch:Partial<Omit<Column,'id'|'builtin'>>}
 |{op:'column.delete';id:string}
 |{op:'column.move';id:string;after:string|null}
 |{op:'option.add';id:string;option:ColumnOption}
 |{op:'row.add';id?:string;values:Record<string,CellValue>;body?:string;after?:string|null}
 |{op:'row.update';id:string;values?:Record<string,CellValue>;body?:string}
 |{op:'row.delete';id:string}
 |{op:'row.move';id:string;after:string|null}
 |{op:'view.save';view:Omit<View,'position'|'id'>&{id?:string}}
 |{op:'view.delete';id:string};
/** `skipped` also names the keys an applied op had to leave out; `converted` counts values a type or option change could not keep. */
export type DbEditResult={db:Database;applied:number;skipped:{index:number;reason:string}[];converted:number};
/** A database without its columns, views and rows. */
export type DbHead=Omit<Database,'columns'|'views'|'rows'>;
/** What GET /api/desk/databases/:id answers (and an edit, after its own fields). Equal versions are equal databases. Asked `since` a version
 * the server still knows: only what changed since (rows new or changed, ids gone, and the columns, views or head when they changed), or the
 * version alone when nothing did. Asked nothing, or since one it no longer knows: the whole database. */
export type DbRead={version:string;database:Database}|{version:string;upserts:Row[];removed:string[];columns?:Column[];views?:View[];head?:DbHead}|{version:string};

const STR=2000,ID=200,NAME=100,LIST=50,OPTIONS=100,BODY=20_000,SORTS=10,VALUES=200;
export const DB_EDIT_OPS=200;
/** What a stored database (one you made, or 「全部」's own columns and views) holds at most; a page table has the catalog's caps. Rows match
 * what a read returns (spec §3.6, ROW_CAP), so nothing is kept that cannot be shown. */
export const DB_LIMITS={columns:100,views:50,rows:5_000} as const;
// Column ids are keys of `values`; these would reach Object.prototype.
const RESERVED=new Set(['__proto__','constructor','prototype']);
const DAY=/^(\d{4})-(\d{2})-(\d{2})$/;
const isObj=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
export const isDateValue=(v:unknown):v is DateValue=>isObj(v)&&typeof v.start==='string';
const clip=(s:string,n=STR)=>s.length>n?s.slice(0,n).replace(/[\ud800-\udbff]$/,''):s;
const get=(r:Row,id:string):CellValue=>Object.hasOwn(r.values,id)?r.values[id]:null;
/** Computed keys define an own property, so even an odd id never sets a prototype. */
const put=(values:Record<string,CellValue>,id:string,v:CellValue)=>{const {[id]:_,...rest}=values;return v===null?rest:{...rest,[id]:v}};
const blank=(v:CellValue|undefined)=>v==null||(typeof v==='string'&&v.trim()==='')||(Array.isArray(v)&&!v.length)||(isDateValue(v)&&!v.start.trim());
const num=(v:CellValue|undefined)=>typeof v==='number'?v:typeof v==='string'&&v.trim()!==''?Number(v):NaN;
const startOf=(v:CellValue|undefined)=>isDateValue(v)?v.start:typeof v==='string'?v:null;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const collator=new Intl.Collator('zh');
const pad=(n:number)=>String(n).padStart(2,'0');
const localDay=(d:Date)=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
// Days are local: Desk and its server run on one machine, so both sides agree on which day a time falls in.
const dayTime=(s:string)=>{const m=DAY.exec(s);if(!m)return NaN;const d=new Date(+m[1],+m[2]-1,+m[3]);return localDay(d)===s?d.getTime():NaN};
const timeOf=(s:string)=>DAY.test(s)?dayTime(s):Date.parse(s);
const dayOf=(s:string)=>{if(DAY.test(s))return s;const t=Date.parse(s);return Number.isNaN(t)?null:localDay(new Date(t))};
/** A plain day on either side compares by day, so "after 10-17" does not take 10-17 09:00. */
const dateCmp=(v:CellValue|undefined,t:CellValue|undefined)=>{const a=startOf(v),b=startOf(t);if(!a||!b)return NaN;
  if(DAY.test(a)||DAY.test(b)){const x=dayOf(a),y=dayOf(b);return x&&y?(x<y?-1:x>y?1:0):NaN}
  return timeOf(a)-timeOf(b)};
const findOpt=(options:ColumnOption[]|undefined,raw:string)=>{const s=raw.trim(),l=s.toLowerCase(),o=options??[];
  return o.find(x=>x.value===s)??o.find(x=>x.label===s)??o.find(x=>x.value.toLowerCase()===l||x.label?.toLowerCase()===l)};
const labelOf=(c:Column,v:string)=>c.options?.find(o=>o.value===v)?.label??v;
const plain=(v:CellValue|undefined):string=>v==null?'':typeof v==='boolean'?(v?L('是','Yes'):L('否','No')):Array.isArray(v)?v.join(', '):isDateValue(v)?(v.end?`${v.start} → ${v.end}`:v.start):String(v);

/** A cell as plain text, for copying and for the assistant: option labels, progress as a percentage, a range as `start → end`. */
export function cellText(column:Column,value:CellValue|undefined):string{
  if(value==null)return '';
  if(column.type==='progress'&&typeof value==='number')return `${Math.round(value*100)}%`;
  if(typeof value==='string')return labelOf(column,value);
  if(Array.isArray(value))return value.map(v=>labelOf(column,v)).join(', ');
  return plain(value);
}

// i18n-ok: matched against what people type, in either language
const YES=new Set(['true','yes','y','1','是','对','✓','checked']),NO=new Set(['false','no','n','0','否','不','unchecked']);
const FAIL={value:null,ok:false} as const;
const httpUrl=(raw:string,httpsOnly:boolean)=>{
  // A bare domain is what people paste; anything else without a scheme is not a link.
  const s=/^[a-z][a-z\d+.-]*:/i.test(raw)||!/^[\w-]+(\.[\w-]+)+([/?#:]|$)/.test(raw)?raw:`https://${raw}`;
  try{const p=new URL(s).protocol;return p==='https:'||(!httpsOnly&&p==='http:')?clip(s):null}catch{return null}
};
const normDate=(raw:string)=>{
  const s=raw.trim();
  if(DAY.test(s))return Number.isNaN(dayTime(s))?null:s;
  // Date.parse alone reads "5" as May 2001, so a four-digit year is required. Without a clock time the value is a plain day.
  if(!/\d{4}/.test(s))return null;
  const t=Date.parse(s);if(Number.isNaN(t))return null;
  return /\d:\d\d/.test(s)?new Date(t).toISOString():localDay(new Date(t));
};
/** Turns a value into what a column of type `to` holds. Empty is always fine (null); what cannot be kept is {value:null,ok:false}. */
export function convertValue(value:CellValue,to:ColumnType,options?:ColumnOption[]):{value:CellValue;ok:boolean}{
  if(blank(value))return {value:null,ok:true};
  const done=(v:CellValue|undefined)=>v==null||(typeof v==='number'&&!Number.isFinite(v))?FAIL:{value:v,ok:true};
  const s=typeof value==='string'?value.trim():typeof value==='number'?String(value):null;
  switch(to){
    case 'text':return done(clip(plain(value)));
    case 'number':return done(typeof value==='boolean'?Number(value):s===null?NaN:Number(s));
    case 'progress':{const n=s===null?NaN:s.endsWith('%')?Number(s.slice(0,-1))/100:Number(s);return Number.isFinite(n)?done(Math.min(1,Math.max(0,n))):FAIL}
    case 'checkbox':{if(typeof value==='boolean')return done(value);if(typeof value==='number')return done(value!==0);
      const l=s?.toLowerCase()??'';return YES.has(l)?done(true):NO.has(l)?done(false):FAIL}
    case 'date':{const parts=isDateValue(value)?[value.start,value.end]:typeof value==='string'?value.split('→'):[];
      if(!parts.length||parts.length>2)return FAIL;
      const start=normDate(parts[0]!),end=parts[1]===undefined||parts[1].trim()===''?undefined:normDate(parts[1]);
      if(!start||end===null)return FAIL;
      return done(end===undefined?{start}:timeOf(end)<timeOf(start)?{start:end,end:start}:{start,end})}
    case 'select':return done((Array.isArray(value)?value.map(x=>findOpt(options,x)).find(Boolean):s===null?undefined:findOpt(options,s))?.value);
    case 'multi':{const parts=Array.isArray(value)?value:s===null?[]:findOpt(options,s)?[s]:s.split(/[,，、]/);
      const out=[...new Set(parts.flatMap(p=>{const o=findOpt(options,p);return o?[o.value]:[]}))].slice(0,LIST);return done(out.length?out:null)}
    case 'url':return done(s===null?null:httpUrl(s,false));
    case 'image':return done(s===null?null:httpUrl(s,true));
    case 'app':return done(s===null?null:clip(findOpt(options,s)?.value??s,ID));
  }
}

const NO_VALUE=new Set<FilterOp>(['empty','not-empty','checked','unchecked']);
const optValue=(c:Column,v:CellValue|undefined)=>{const s=plain(v).trim();return findOpt(c.options,s)?.value??s};
function eq(c:Column,v:CellValue,t:CellValue|undefined):boolean{
  switch(c.type){
    case 'checkbox':return (v===true)===(convertValue(t??null,'checkbox').value===true);
    case 'multi':{const want=(Array.isArray(t)?t:[t]).map(x=>optValue(c,x));return Array.isArray(v)&&want.every(w=>v.includes(w))}
    case 'number':case 'progress':return num(v)===num(t);
    case 'date':return dateCmp(v,t)===0;
    case 'select':case 'app':return !blank(v)&&plain(v)===optValue(c,t);
    default:return !blank(v)&&plain(v)===plain(t);
  }
}
function matches(c:Column,f:Filter,v:CellValue):boolean{
  const t=f.value;
  switch(f.op){
    case 'is':return eq(c,v,t);
    case 'is-not':return !eq(c,v,t);
    case 'contains':case 'not-contains':{const needle=plain(t).trim().toLowerCase();
      const hit=c.type==='multi'?eq(c,v,t):!blank(v)&&[plain(v),cellText(c,v)].some(x=>x.toLowerCase().includes(needle));return f.op==='contains'?hit:!hit}
    case 'empty':return c.type==='checkbox'?v!==true:blank(v);
    case 'not-empty':return c.type==='checkbox'?v===true:!blank(v);
    case 'gt':case 'lt':{const d=c.type==='date'?dateCmp(v,t):num(v)-num(t);return f.op==='gt'?d>0:d<0}
    case 'before':return dateCmp(v,t)<0;
    case 'after':return dateCmp(v,t)>0;
    case 'checked':return v===true;
    case 'unchecked':return v!==true;
  }
}
/** Orders two non-empty cells of a column. Values of the wrong type (left by an old table, say) sort after the right ones. */
function comparator(c:Column):(a:CellValue,b:CellValue)=>number{
  const text=(a:CellValue,b:CellValue)=>collator.compare(cellText(c,a),cellText(c,b));
  const finite=(x:number,y:number,a:CellValue,b:CellValue)=>Number.isFinite(x)&&Number.isFinite(y)?x-y:Number.isFinite(x)?-1:Number.isFinite(y)?1:text(a,b);
  switch(c.type){
    case 'number':case 'progress':return (a,b)=>finite(num(a),num(b),a,b);
    case 'date':return (a,b)=>{const x=startOf(a),y=startOf(b);return finite(x?timeOf(x):NaN,y?timeOf(y):NaN,a,b)};
    case 'checkbox':return (a,b)=>Number(a===true)-Number(b===true);
    case 'select':case 'multi':case 'app':{const rank=new Map((c.options??[]).map((o,i)=>[o.value,i]));
      const r=(v:CellValue)=>rank.get(Array.isArray(v)?v[0]:plain(v))??Infinity;
      return (a,b)=>{const x=r(a),y=r(b);return x===y?text(a,b):x<y?-1:1}}
    default:return text;
  }
}
export const byPosition=(a:{id:string;position:number},b:{id:string;position:number})=>a.position-b.position||(a.id<b.id?-1:a.id>b.id?1:0);
const keysOf=(c:Column,v:CellValue):string[]=>{
  if(blank(v))return [];
  if(Array.isArray(v))return [...new Set(v)];
  if(c.type==='date'){const s=startOf(v)!;return [dayOf(s)??s]}
  if(c.type==='number'||c.type==='progress'){const n=num(v);return [Number.isFinite(n)?String(n):plain(v)]}
  return [plain(v)];
};
/** Option-backed groups are all there, empty or not, so a board always has a column to drop into. Other values follow, then 未填. */
function group(c:Column|undefined,rows:Row[],sumCols:Column[]):Group[]{
  const mk=(key:string|null,label:string,rs:Row[]):Group=>({key,label,rows:rs,count:rs.length,
    sums:Object.fromEntries(sumCols.map(s=>[s.id,rs.reduce((t,r)=>{const n=num(get(r,s.id));return Number.isFinite(n)?t+n:t},0)]))});
  if(!c)return [mk(null,'',rows)];
  if(c.type==='checkbox')return [mk('true',L('是','Yes'),rows.filter(r=>get(r,c.id)===true)),mk('false',L('否','No'),rows.filter(r=>get(r,c.id)!==true))];
  const buckets=new Map<string,Row[]>(),empty:Row[]=[];
  for(const r of rows){const keys=keysOf(c,get(r,c.id));if(!keys.length)empty.push(r);for(const k of keys){const b=buckets.get(k);if(b)b.push(r);else buckets.set(k,[r])}}
  const opts=c.type==='select'||c.type==='multi'||c.type==='app'?c.options??[]:[],known=new Set(opts.map(o=>o.value));
  const order=c.type==='number'||c.type==='progress'?(a:string,b:string)=>Number(a)-Number(b)||collator.compare(a,b):c.type==='date'?(a:string,b:string)=>a<b?-1:a>b?1:0:collator.compare;
  const rest=[...buckets.keys()].filter(k=>!known.has(k)).sort(order);
  return [...opts.map(o=>mk(o.value,o.label??o.value,buckets.get(o.value)??[])),...rest.map(k=>mk(k,labelOf(c,k),buckets.get(k)!)),...(empty.length?[mk(null,L('未填','Empty'),empty)]:[])];
}
/** Filter, then sort (empty last whichever way, position breaks ties), then group. A condition on a missing column, or one still
 * waiting for its value, is left out; with none left every row passes. */
export function applyView(db:Pick<Database,'columns'|'rows'>,config:ViewConfig):Group[]{
  const byId=new Map(db.columns.map(c=>[c.id,c]));
  const filters=(config.filters??[]).flatMap(f=>{const c=byId.get(f.column);return c&&FILTER_OPS.includes(f.op)&&(NO_VALUE.has(f.op)||!blank(f.value))?[{c,f}]:[]});
  const hit=(r:Row)=>{const t=(x:{c:Column;f:Filter})=>matches(x.c,x.f,get(r,x.c.id));return config.match==='any'?filters.some(t):filters.every(t)};
  const sorts=(config.sorts??[]).flatMap(s=>{const c=byId.get(s.column);return c?[{c,dir:s.dir==='desc'?-1:1,cmp:comparator(c)}]:[]});
  const rows=(filters.length?db.rows.filter(hit):db.rows.slice()).sort((a,b)=>{
    for(const s of sorts){
      // A checkbox has no empty: unset is unchecked.
      const x=get(a,s.c.id),y=get(b,s.c.id),ex=s.c.type!=='checkbox'&&blank(x),ey=s.c.type!=='checkbox'&&blank(y);
      if(ex||ey){if(ex&&ey)continue;return ex?1:-1}
      const d=s.cmp(x,y);if(d)return d*s.dir;
    }
    return byPosition(a,b);
  });
  const sumCols=db.columns.filter(c=>c.type==='number'||c.type==='progress');
  return group(config.group===undefined?undefined:byId.get(config.group),rows,sumCols);
}

const LINE=()=>L('这一行就是一条线','This row is a thread'),GONE_ROW=()=>L('这一行已经不在','This row is gone'),GONE_COL=()=>L('这一列已经不在','This column is gone'),
  GONE_VIEW=()=>L('这个视图已经不在','This view is gone'),GONE_AFTER=()=>L('要放的位置已经不在','The place to put it is gone'),NO_ID=()=>L('分不出新的 id','Couldn\'t make a new id');
/** Built-in columns are computed from the thread, so only those marked editable write back; any other column is editable unless locked. */
const editable=(c:Column)=>c.builtin?c.editable===true:c.editable!==false;
const okWidth=(w:number|undefined):w is number=>typeof w==='number'&&Number.isFinite(w)&&w>0;
const normOptions=(o:ColumnOption[])=>{const seen=new Set<string>();return o.flatMap(x=>{const value=x.value.trim(),label=x.label?.trim();
  if(!value||seen.has(value))return [];seen.add(value);
  return [{value,...(label?{label}:{}),...(x.color&&OPTION_COLORS.includes(x.color)?{color:x.color}:{})}]}).slice(0,OPTIONS)};
const normConfig=(c:Partial<ViewConfig>):ViewConfig=>({...c,filters:Array.isArray(c.filters)?c.filters:[],match:c.match==='any'?'any':'all',sorts:Array.isArray(c.sorts)?c.sorts:[]});
/** A deleted column leaves nothing behind in a view: no condition, sort, grouping, shown column, or date/plan/cover choice. */
const unref=(c:ViewConfig,id:string):ViewConfig=>{
  const keys=(['group','date','planDate','cover'] as const).filter(k=>c[k]===id),filters=c.filters??[],sorts=c.sorts??[];
  if(!keys.length&&!filters.some(f=>f.column===id)&&!sorts.some(s=>s.column===id)&&!c.visible?.includes(id))return c;
  const n:ViewConfig={...c,filters:filters.filter(f=>f.column!==id),sorts:sorts.filter(s=>s.column!==id),...(c.visible?{visible:c.visible.filter(x=>x!==id)}:{})};
  for(const k of keys)delete n[k];
  return n;
};
/** Index to insert at: after `after`, first for null, last when absent; -1 when `after` is not there. */
const place=(list:{id:string}[],after:string|null|undefined)=>{if(after===undefined)return list.length;if(after===null)return 0;const i=list.findIndex(x=>x.id===after);return i<0?-1:i+1};

/** Applies a batch of edits without touching `db`. Each op stands alone: one naming something that is not there is skipped with a
 * reason and the next one still runs. Untouched rows, columns and views keep their identity, so a caller can diff by reference;
 * changed rows and the database get `updatedAt = now`. Rows and views come back in position order; columns are in array order. */
export function applyDbOps(db:Database,ops:DbEditOp[],now:number,newId:()=>string):DbEditResult{
  const threads=db.kind==='threads',skipped:DbEditResult['skipped']=[];
  let columns=db.columns.slice(),rows=db.rows.slice(),views=db.views.slice(),applied=0,converted=0,index=0;
  const note=(reason:string)=>{skipped.push({index,reason})},no=(reason:string)=>{note(reason);return false};
  const colAt=(id:string)=>columns.findIndex(c=>c.id===id),rowAt=(id:string)=>rows.findIndex(r=>r.id===id);
  const fresh=(taken:(id:string)=>boolean)=>{for(let i=0;i<20;i++){const id=newId();if(id&&!RESERVED.has(id)&&!taken(id))return id}return null};
  const touch=(i:number,patch:Partial<Omit<Row,'id'|'updatedAt'>>)=>{rows[i]={...rows[i],...patch,updatedAt:now}};
  /** Rows sit at float positions so a move rewrites one row. Once halving leaves no room between two neighbours, every row is renumbered. */
  const slot=(after:string|null|undefined,self?:string):number|null=>{
    const others=rows.filter(r=>r.id!==self),anchor=typeof after==='string'?others.find(r=>r.id===after):undefined;
    if(typeof after==='string'&&!anchor)return null;
    if(after===undefined)return others.reduce((m,r)=>Math.max(m,r.position+1),0);
    const later=anchor?others.filter(r=>byPosition(r,anchor)>0):others,next=later.length?later.reduce((m,r)=>Math.min(m,r.position),Infinity):undefined;
    if(!anchor)return next===undefined?0:next-1;
    if(next===undefined)return anchor.position+1;
    const mid=(anchor.position+next)/2;if(mid>anchor.position&&mid<next)return mid;
    const order=rows.map((_,i)=>i).filter(i=>rows[i].id!==self).sort((a,b)=>byPosition(rows[a],rows[b]));
    order.forEach((i,n)=>{if(rows[i].position!==n)touch(i,{position:n})});
    return order.findIndex(i=>rows[i].id===after)+0.5;
  };
  /** What fits each column is kept; the rest is reported in one note and left out, so the op still applies to the valid keys. */
  const coerce=(values:Record<string,CellValue>|undefined)=>{
    const out:[string,CellValue][]=[],bad:string[]=[];
    for(const [k,v] of Object.entries(values??{})){
      const i=RESERVED.has(k)?-1:colAt(k),c=columns[i];
      if(i<0){bad.push(L(`没有「${k}」这一列`,`There's no “${k}” column`));continue}
      if(!editable(c)){bad.push(L(`「${c.name}」不能改`,`“${c.name}” can't be changed`));continue}
      const r=convertValue(v,c.type,c.options);
      if(!r.ok){bad.push(L(`「${c.name}」的值不对`,`The value for “${c.name}” doesn't fit`));continue}
      // Desk works out the other states from the conversation; a person can only start a thread or finish it.
      if(threads&&c.builtin&&c.id==='state'&&r.value!=='doing'&&r.value!=='done'){bad.push(L('「状态」只能改成推进中或做完','“State” can only be set to In progress or Done'));continue}
      if(threads&&c.builtin&&c.id==='title'&&r.value===null){bad.push(L('「标题」不能为空','“Title” can\'t be empty'));continue}
      out.push([k,r.value]);
    }
    return {out,bad:bad.join(L('；','; '))};
  };
  const run=(op:DbEditOp):boolean=>{
    switch(op.op){
      case 'column.add':{
        const c=op.column,name=c.name?.trim();
        if(!COLUMN_TYPES.includes(c.type))return no(L('列的类型不对','Not a column type'));
        if(!name)return no(L('列名不能为空','The column needs a name'));
        if(c.id!==undefined&&(colAt(c.id)>=0||RESERVED.has(c.id)))return no(L('这一列已经有了','This column already exists'));
        if(db.kind!=='page'&&columns.length>=DB_LIMITS.columns)return no(L(`最多 ${DB_LIMITS.columns} 列`,`At most ${DB_LIMITS.columns} columns`));
        const at=place(columns,op.after);if(at<0)return no(GONE_AFTER());
        const id=c.id??fresh(x=>colAt(x)>=0);if(!id)return no(NO_ID());
        columns.splice(at,0,{id,name:clip(name,NAME),type:c.type,...(c.options?{options:normOptions(c.options)}:{}),
          ...(c.editable===undefined?{}:{editable:c.editable}),...(okWidth(c.width)?{width:c.width}:{})});
        return true;
      }
      case 'column.update':{
        const i=colAt(op.id);if(i<0)return no(GONE_COL());
        const c=columns[i],p=op.patch,next:Column={...c};
        // A built-in column's name, type and options are the thread's; only its width is layout.
        if(c.builtin&&Object.entries(p).some(([k,v])=>k!=='width'&&v!==undefined))return no(L('内置列只能改宽度','Only the width of a built-in column can change'));
        if(p.name!==undefined){const name=p.name.trim();if(!name)return no(L('列名不能为空','The column needs a name'));next.name=clip(name,NAME)}
        if(p.type!==undefined){if(!COLUMN_TYPES.includes(p.type))return no(L('列的类型不对','Not a column type'));next.type=p.type}
        if(p.options!==undefined)next.options=normOptions(p.options);
        if(p.editable!==undefined)next.editable=p.editable;
        if(p.width!==undefined){if(!okWidth(p.width))return no(L('宽度不对','Not a valid width'));next.width=p.width}
        columns[i]=next;
        // A select value has to be among the options, so dropping an option clears the cells that held it (undo brings them back).
        if(next.type!==c.type||(p.options!==undefined&&(next.type==='select'||next.type==='multi')))rows.forEach((r,j)=>{
          if(!Object.hasOwn(r.values,c.id))return;
          const v=r.values[c.id],x=convertValue(v,next.type,next.options);
          if(!x.ok)converted++;
          if(!same(x.value,v))touch(j,{values:put(r.values,c.id,x.value)});
        });
        return true;
      }
      case 'column.delete':{
        const i=colAt(op.id);if(i<0)return no(GONE_COL());
        const c=columns[i];if(c.builtin)return no(L('内置列不能删','A built-in column can\'t be deleted'));
        columns.splice(i,1);
        rows.forEach((r,j)=>{if(Object.hasOwn(r.values,c.id))touch(j,{values:put(r.values,c.id,null)})});
        views=views.map(v=>{const config=unref(v.config,c.id);return config===v.config?v:{...v,config}});
        return true;
      }
      case 'column.move':{
        const i=colAt(op.id);if(i<0)return no(GONE_COL());if(op.after===op.id)return true;
        const rest=columns.filter((_,j)=>j!==i),at=place(rest,op.after);if(at<0)return no(GONE_AFTER());
        rest.splice(at,0,columns[i]);columns=rest;return true;
      }
      case 'option.add':{
        // One choice added to the list the column has now, so a client holding an older list drops none added meanwhile.
        const i=colAt(op.id);if(i<0)return no(GONE_COL());
        const c=columns[i],[o]=normOptions([op.option]);if(c.builtin)return no(L('内置列只能改宽度','Only the width of a built-in column can change'));
        if(c.type!=='select'&&c.type!=='multi')return no(L('这一列没有选项','This column has no options'));if(!o)return no(L('选项不能为空','The option can\'t be empty'));
        if(c.options?.some(x=>x.value===o.value))return true;
        if((c.options?.length??0)>=OPTIONS)return no(L(`最多 ${OPTIONS} 个选项`,`At most ${OPTIONS} options`));
        columns[i]={...c,options:[...c.options??[],o]};return true;
      }
      case 'row.add':{
        if(threads)return no(LINE());
        if(op.id!==undefined&&(rowAt(op.id)>=0||RESERVED.has(op.id)))return no(L('这一行已经有了','This row already exists'));
        if(db.kind==='user'&&rows.length>=DB_LIMITS.rows)return no(L(`最多 ${DB_LIMITS.rows} 行`,`At most ${DB_LIMITS.rows} rows`));
        if(typeof op.after==='string'&&rowAt(op.after)<0)return no(GONE_AFTER());
        const id=op.id??fresh(x=>rowAt(x)>=0);if(!id)return no(NO_ID());
        const {out,bad}=coerce(op.values),position=slot(op.after)!;
        if(bad)note(bad);
        rows.push({id,values:Object.fromEntries(out.filter(([,v])=>v!==null)),...(op.body?{body:op.body}:{}),position,updatedAt:now});
        return true;
      }
      case 'row.update':{
        const i=rowAt(op.id);if(i<0)return no(GONE_ROW());
        const {out,bad}=coerce(op.values);
        if(!out.length&&op.body===undefined)return no(bad||L('没有要改的','Nothing to change'));
        if(bad)note(bad);
        const r=rows[i],next:Row={...r,values:out.reduce((v,[k,x])=>put(v,k,x),r.values),updatedAt:now};
        if(op.body!==undefined){if(op.body)next.body=op.body;else delete next.body}
        rows[i]=next;return true;
      }
      case 'row.delete':{
        if(threads)return no(LINE());
        const i=rowAt(op.id);if(i<0)return no(GONE_ROW());
        rows.splice(i,1);return true;
      }
      case 'row.move':{
        if(threads)return no(LINE());
        const i=rowAt(op.id);if(i<0)return no(GONE_ROW());if(op.after===op.id)return true;
        const position=slot(op.after,op.id);if(position===null)return no(GONE_AFTER());
        touch(i,{position});return true;
      }
      case 'view.save':{
        // Saving a view id that is not there creates it under that id, so a client can switch to the view it just made.
        const v=op.view,name=v.name?.trim();
        if(!VIEW_TYPES.includes(v.type))return no(L('视图类型不对','Not a view type'));
        if(!name)return no(L('视图名不能为空','The view needs a name'));
        if(v.id!==undefined&&RESERVED.has(v.id))return no(L('视图的 id 不能用','This view id can\'t be used'));
        const config=normConfig(v.config??{}),i=v.id===undefined?-1:views.findIndex(x=>x.id===v.id);
        if(i>=0){views[i]={...views[i],name:clip(name,NAME),type:v.type,config};return true}
        if(db.kind!=='page'&&views.length>=DB_LIMITS.views)return no(L(`最多 ${DB_LIMITS.views} 个视图`,`At most ${DB_LIMITS.views} views`));
        const id=v.id??fresh(x=>views.some(y=>y.id===x));if(!id)return no(NO_ID());
        views.push({id,name:clip(name,NAME),type:v.type,config,position:views.reduce((m,x)=>Math.max(m,x.position+1),0)});
        return true;
      }
      case 'view.delete':{
        const i=views.findIndex(x=>x.id===op.id);if(i<0)return no(GONE_VIEW());
        if(views.length<2)return no(L('至少要留一个视图','At least one view has to stay'));
        views.splice(i,1);return true;
      }
      default:return no(L('不认识的改动','Not a known change'));
    }
  };
  for(;index<ops.length;index++)if(run(ops[index]))applied++;
  rows.sort(byPosition);views.sort(byPosition);
  return {db:{...db,columns,rows,views,updatedAt:applied?now:db.updatedAt},applied,skipped,converted};
}

// Input from the network or the assistant. Shapes only: whether ids exist and values fit their columns is applyDbOps's job.
const id=z.string().min(1).max(ID).refine(s=>!RESERVED.has(s),()=>({message:L('这个 id 不能用','This id can\'t be used')})),after=id.nullable();
const dateValue=z.object({start:z.string().min(1).max(NAME),end:z.string().min(1).max(NAME).optional()}).strict();
const cellValue:z.ZodType<CellValue>=z.union([z.string().max(STR),z.number().finite(),z.boolean(),z.array(z.string().max(STR)).max(LIST),dateValue,z.null()]);
const values=z.record(id,cellValue).refine(v=>Object.keys(v).length<=VALUES,()=>({message:L('一次改的列太多','Too many columns in one change')}));
const option=z.object({value:z.string().trim().min(1).max(ID),label:z.string().max(NAME).optional(),color:z.enum(OPTION_COLORS).optional()}).strict();
const columnFields={name:z.string().trim().min(1).max(NAME),type:z.enum(COLUMN_TYPES),options:z.array(option).max(OPTIONS).optional(),
  editable:z.boolean().optional(),width:z.number().finite().min(40).max(2000).optional()};
const filter=z.object({column:id,op:z.enum(FILTER_OPS),value:cellValue.optional()}).strict();
const viewConfig=z.object({filters:z.array(filter).max(LIST),match:z.enum(['all','any']),sorts:z.array(z.object({column:id,dir:z.enum(['asc','desc'])}).strict()).max(SORTS),
  group:id.optional(),visible:z.array(id).max(VALUES).optional(),date:id.optional(),planDate:id.optional(),cover:id.optional(),
  component:z.string().min(1).max(ID).optional(),code:z.string().max(CODE).refine(codeFits,()=>({message:L('代码最多 200 KB','Code can be at most 200 KB')})).optional()}).strict();
const body=z.string().max(BODY);
/** What a database is made with besides its name (POST /databases): columns (an id of its own is kept, so rows and views can name it), rows as
 * their values and body, views. Ids of rows are made fresh. The shapes an edit's ops carry, so a column or view is checked once. */
export const dbColumnInput=z.object({...columnFields,id:id.optional()}).strict();
export const dbViewInput=z.object({id:id.optional(),name:z.string().trim().min(1).max(NAME),type:z.enum(VIEW_TYPES),config:viewConfig}).strict();
export const dbRowInput=z.object({values,body:body.optional()}).strict();
export type NewColumn=Omit<Column,'id'|'builtin'>&{id?:string};
export type NewView=Omit<View,'id'|'position'>&{id?:string};
export type NewRow={values:Record<string,CellValue>;body?:string};
/** A view one place keeps for itself, outside the database (a project page's threads block, by block id): its type and settings only.
 * A custom view runs code, so it is never kept this way. */
export type SavedView={type:Exclude<ViewType,'custom'>;config:ViewConfig};
export const savedViewInput:z.ZodType<SavedView>=z.object({type:z.enum(['table','board','list','calendar','gallery','timeline']),
  config:viewConfig.omit({component:true,code:true})}).strict();
/** The ops of one edit; a page table's edit (shared/page-edit) carries the same list. */
export const dbEditOps:z.ZodType<DbEditOp[]>=z.array(z.discriminatedUnion('op',[
  z.object({op:z.literal('column.add'),column:dbColumnInput,after:after.optional()}).strict(),
  z.object({op:z.literal('column.update'),id,patch:z.object(columnFields).partial().strict()}).strict(),
  z.object({op:z.literal('column.delete'),id}).strict(),
  z.object({op:z.literal('column.move'),id,after}).strict(),
  z.object({op:z.literal('option.add'),id,option}).strict(),
  z.object({op:z.literal('row.add'),id:id.optional(),values,body:body.optional(),after:after.optional()}).strict(),
  z.object({op:z.literal('row.update'),id,values:values.optional(),body:body.optional()}).strict(),
  z.object({op:z.literal('row.delete'),id}).strict(),
  z.object({op:z.literal('row.move'),id,after}).strict(),
  z.object({op:z.literal('view.save'),view:dbViewInput}).strict(),
  z.object({op:z.literal('view.delete'),id}).strict(),
])).min(1).max(DB_EDIT_OPS);
export const dbEditInput:z.ZodType<{ops:DbEditOp[]}>=z.object({ops:dbEditOps}).strict();

/** A table on a project page, the `database` member of the PageBlock union (validated by shared/desk-blocks); rows keep their order by array position. */
export type DatabaseBlock={id:string;type:'database';title?:string;columns:Column[];rows:{id:string;values:Record<string,CellValue>;body?:string}[];views?:View[]};
export const DEFAULT_TABLE_VIEW:View={id:'table',get name(){return L('表格','Table')},type:'table',position:0,config:{filters:[],match:'all',sorts:[]}};
/** The block as a database, so the page table edits like any other; a block without views gets one table. */
export function blockToDatabase(block:DatabaseBlock):Database{
  return {id:block.id,title:block.title??'',kind:'page',columns:block.columns,views:block.views?.length?block.views:[DEFAULT_TABLE_VIEW],
    rows:block.rows.map((r,i)=>({id:r.id,values:r.values,...(r.body?{body:r.body}:{}),position:i,updatedAt:0})),updatedAt:0};
}
/** The edited database written back over `block`; whatever else the block carries (sources, the edit mark) is kept. */
export function databaseToBlock(db:Database,block:DatabaseBlock):DatabaseBlock{
  const {title:_,...rest}=block,title=db.title.trim()||block.title;
  return {...rest,...(title?{title}:{}),columns:db.columns,rows:db.rows.map(r=>({id:r.id,values:r.values,...(r.body?{body:r.body}:{})})),views:db.views};
}

export const THREADS_DB='threads';
/** The only states a person sets on a thread; the others Desk works out from the conversation. */
export const THREAD_WRITABLE_STATES:readonly ThreadState[]=['doing','done'];
const STATE_OPTIONS:(ColumnOption&{value:ThreadState})[]=[{value:'waiting',get label(){return L('等你','Waiting on you')},color:'blue'},{value:'stalled',get label(){return L('停住','Stalled')},color:'amber'},
  {value:'doing',get label(){return L('推进中','In progress')},color:'violet'},{value:'done',get label(){return L('做完','Done')},color:'green'},{value:'idea',get label(){return L('只聊过','Idea')},color:'gray'}];
/** The threads database's built-in columns; copy before filling in. `project` is a select whose options (value = project id, label = its
 * title) the server fills at read time in sidebar order, so grouping by project follows the sidebar and survives a rename. `app` holds the
 * app's display name, `lastActivity` a {start} ISO time. Only title, state and next write back to the thread. */
export const THREAD_COLUMNS:Column[]=[
  {id:'title',get name(){return L('标题','Title')},type:'text',builtin:true,editable:true},
  {id:'project',get name(){return L('项目','Project')},type:'select',options:[],builtin:true,editable:false},
  {id:'state',get name(){return L('状态','State')},type:'select',options:STATE_OPTIONS,builtin:true,editable:true},
  {id:'app',name:'App',type:'app',builtin:true,editable:false},
  {id:'lastActivity',get name(){return L('最近活动','Last activity')},type:'date',builtin:true,editable:false},
  {id:'next',get name(){return L('下一步','Next step')},type:'text',builtin:true,editable:true},
  {id:'stoppedAt',get name(){return L('停在','Stopped at')},type:'text',builtin:true,editable:false},
  {id:'code',get name(){return L('代码','Code')},type:'text',builtin:true,editable:false},
];
const recent=():ViewConfig['sorts']=>[{column:'lastActivity',dir:'desc'}];
/** Shown until the person saves a view of their own. The board's cards carry only the short facts; 下一步, 停在 and 代码 stay in the table. */
export const DEFAULT_THREAD_VIEWS:View[]=[
  {id:'threads-board',get name(){return L('看板','Board')},type:'board',position:0,config:{filters:[],match:'all',sorts:recent(),group:'state',visible:['title','project','state','app','lastActivity']}},
  {id:'threads-table',get name(){return L('表格','Table')},type:'table',position:1,config:{filters:[],match:'all',sorts:recent()}},
  {id:'threads-timeline',get name(){return L('时间线','Timeline')},type:'timeline',position:2,config:{filters:[],match:'all',sorts:recent(),group:'project',date:'lastActivity'}},
];
