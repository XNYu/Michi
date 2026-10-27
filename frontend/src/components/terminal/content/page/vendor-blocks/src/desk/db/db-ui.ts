import {THREAD_WRITABLE_STATES,type CellValue,type Column,type ColumnOption,type ColumnType,type Database,type FilterOp,type Group,type View,type ViewConfig,type ViewType} from '../../../shared/desk-db';
import {L,locale} from '../../../shared/i18n';

export type OptionColor=NonNullable<ColumnOption['color']>;

export const TYPE_LABEL:Record<ColumnType,string>=L({text:'文本',number:'数字',date:'日期',select:'单选',multi:'多选',checkbox:'勾选',url:'链接',progress:'进度',app:'App',image:'图片'},
  {text:'Text',number:'Number',date:'Date',select:'Select',multi:'Multi-select',checkbox:'Checkbox',url:'Link',progress:'Progress',app:'App',image:'Image'});
export const COLUMN_TYPE_ORDER:ColumnType[]=['text','number','select','multi','date','checkbox','url','progress','image','app'];
export const VIEW_LABEL:Record<ViewType,string>=L({table:'表格',board:'看板',list:'列表',calendar:'日历',gallery:'画廊',timeline:'时间线',custom:'自定义'},
  {table:'Table',board:'Board',list:'List',calendar:'Calendar',gallery:'Gallery',timeline:'Timeline',custom:'Custom'});
/** What「+ 视图」offers. */
export const NEW_VIEW_TYPES:ViewType[]=['table','board','list','calendar','gallery','timeline','custom'];
export const OP_LABEL:Record<FilterOp,string>=L({is:'是','is-not':'不是',contains:'包含','not-contains':'不包含',empty:'为空','not-empty':'不为空',gt:'大于',lt:'小于',before:'早于',after:'晚于',checked:'已勾选',unchecked:'没勾选'},
  {is:'is','is-not':'is not',contains:'contains','not-contains':'doesn\'t contain',empty:'is empty','not-empty':'isn\'t empty',gt:'is more than',lt:'is less than',before:'is before',after:'is after',checked:'is checked',unchecked:'isn\'t checked'});
/** The conditions that make sense for each type, most useful first. */
export const OPS_FOR:Record<ColumnType,FilterOp[]>={text:['contains','not-contains','is','is-not','empty','not-empty'],url:['contains','not-contains','empty','not-empty'],
  image:['empty','not-empty'],app:['is','is-not','empty','not-empty'],number:['is','is-not','gt','lt','empty','not-empty'],progress:['gt','lt','is','empty','not-empty'],
  date:['is','before','after','empty','not-empty'],select:['is','is-not','empty','not-empty'],multi:['contains','not-contains','empty','not-empty'],checkbox:['checked','unchecked']};
export const NO_VALUE_OPS=new Set<FilterOp>(['empty','not-empty','checked','unchecked']);
export const COLOR_LABEL:Record<OptionColor,string>=L({gray:'灰',blue:'蓝',green:'绿',amber:'黄',red:'红',violet:'紫'},{gray:'Gray',blue:'Blue',green:'Green',amber:'Yellow',red:'Red',violet:'Purple'});
// Option colours are only ever a dot beside neutral text, so even the light ones stay readable.
const COLOR_HEX:Record<OptionColor,string>={gray:'#a1a1aa',blue:'#2563eb',green:'#16a34a',amber:'#d97706',red:'#dc2626',violet:'#8b5cf6'};
const STATE_HEX:Record<string,string>={waiting:'var(--desk-waiting,#2563eb)',stalled:'var(--desk-stalled,#d97706)',doing:'var(--desk-doing,#93c5fd)',done:'var(--desk-done,#16a34a)',idea:'var(--desk-calm,#a1a1aa)'};
/** A thread's state keeps the desk's status colours whatever its option says. */
export const isThreadState=(db:Pick<Database,'kind'>,c:Column)=>db.kind==='threads'&&!!c.builtin&&c.id==='state';
export function dotColor(db:Pick<Database,'kind'>,c:Column,value:string):string|undefined{
  if(isThreadState(db,c))return STATE_HEX[value];
  const color=c.options?.find(o=>o.value===value)?.color;return color&&COLOR_HEX[color];
}
export const colorHex=(color:OptionColor)=>COLOR_HEX[color];
/** Built-in columns are the thread's, so only those marked editable take a value; the same rule as applyDbOps. */
export const cellEditable=(c:Column)=>c.builtin?c.editable===true:c.editable!==false;
/** The states a person may set on 「全部」; Desk works the others out from the conversation. */
const EMPTY:ReadonlySet<string>=new Set();
export const lockedOptions=(db:Pick<Database,'kind'>,c:Column):ReadonlySet<string>=>isThreadState(db,c)?new Set((c.options??[]).map(o=>o.value).filter(v=>!THREAD_WRITABLE_STATES.includes(v as never))):EMPTY;
export const AUTO_STATE=L('这个状态是按对话自动判断的','Desk works this state out from the conversation');
/** The column that names a row: a thread's title, otherwise the first text column (the first column when there is none). It is never hidden. */
export const titleColumn=(db:Pick<Database,'kind'|'columns'>)=>(db.kind==='threads'?db.columns.find(c=>c.id==='title'):undefined)??db.columns.find(c=>c.type==='text')??db.columns[0];
/** What a board splits into columns by: the view's grouping, else the first single-select column. */
export const boardGroup=(db:Pick<Database,'columns'>,config:ViewConfig)=>db.columns.find(c=>c.id===config.group)??db.columns.find(c=>c.type==='select');
/** A gallery's cover: the view's `cover` column when it is an image column, else the first image column. */
export const coverColumn=(db:Pick<Database,'columns'>,config:ViewConfig)=>db.columns.find(c=>c.id===config.cover&&c.type==='image')??db.columns.find(c=>c.type==='image');
/** Columns the view shows, in the database's order; `visible` unset means all. */
export function shownColumns(db:Pick<Database,'kind'|'columns'>,config:ViewConfig):Column[]{
  if(!config.visible)return db.columns;
  const keep=new Set(config.visible),title=titleColumn(db)?.id;return db.columns.filter(c=>keep.has(c.id)||c.id===title);
}
export const viewSave=(view:View,config:ViewConfig)=>({op:'view.save' as const,view:{id:view.id,name:view.name,type:view.type,config}});
/** A row made under simple conditions starts out meeting them, so it does not vanish as soon as it is made. */
export function startValues(db:Pick<Database,'columns'>,config:ViewConfig):Record<string,CellValue>{
  const values:Record<string,CellValue>={};
  if(config.match!=='any')for(const f of config.filters)if(f.op==='is'&&f.value!=null&&!Array.isArray(f.value)&&db.columns.some(c=>c.id===f.column))values[f.column]=f.value;
  return values;
}
let seq=0;
/** Ids made here go with the op, so the screen and the server agree on them before the server has answered. */
export function newId(prefix:string){
  const random=globalThis.crypto?.randomUUID?.().replace(/-/g,'').slice(0,10)??`${Date.now().toString(36)}${(++seq).toString(36)}`;
  return `${prefix}-${random}`;
}
const pad=(n:number)=>String(n).padStart(2,'0');
export const today=()=>{const d=new Date();return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;};
/** 'YYYY-MM-DD' is a local day; anything else is a time. Bad input gives null. */
export function parseDay(s:string):Date|null{
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(s);if(m)return new Date(+m[1],+m[2]-1,+m[3]);
  const t=Date.parse(s);return Number.isNaN(t)?null:new Date(t);
}
export const dayKey=(s:string)=>{const d=parseDay(s);return d?`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`:null;};
/** 「10月17日」; another year's day says its year. */
export function dayLabel(s:string):string{
  const d=parseDay(s);if(!d)return s;
  const thisYear=d.getFullYear()===new Date().getFullYear();
  return L(thisYear?`${d.getMonth()+1}月${d.getDate()}日`:`${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日`,d.toLocaleDateString('en-US',{month:'short',day:'numeric',...thisYear?{}:{year:'numeric'}}));
}
export const domainOf=(url:string)=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return url;}};
const number=new Intl.NumberFormat(locale(),{maximumFractionDigits:2});
/** A group's number columns as its heading says them (a table's group row, a board column). Empty cells count for neither: a sum of
 * nothing is not shown, and an average is over the rows that have a value. */
export function groupSums(g:Group,shown:Column[]):string[]{
  return shown.flatMap(c=>{
    const sum=g.sums[c.id],filled=g.rows.filter(r=>typeof r.values[c.id]==='number').length;if(sum===undefined||!filled)return [];
    return c.type==='progress'?[L(`${c.name} 平均 ${Math.round(sum/filled*100)}%`,`${c.name} average ${Math.round(sum/filled*100)}%`)]:[L(`${c.name} 合计 ${number.format(sum)}`,`${c.name} total ${number.format(sum)}`)];
  });
}
export const sameValue=(a:CellValue|undefined,b:CellValue|undefined)=>JSON.stringify(a??null)===JSON.stringify(b??null);
