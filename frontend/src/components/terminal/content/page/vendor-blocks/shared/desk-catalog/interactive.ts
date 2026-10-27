import {z} from 'zod';
import {L} from '../i18n.ts';
import {COLUMN_TYPES,FILTER_OPS,OPTION_COLORS,VIEW_TYPES,convertValue,type CellValue,type Column,type ColumnOption,type DatabaseBlock,type View} from '../desk-db.ts';
import {ID,LIST,SCAN,SHORT,arr,block,blockId,cell,clip,codeFits,entry,height,idOf,isObj,list,maybe,num,opt,or,scalar,stext,str,text,unique,type PageBlockMeta} from './fields.ts';

// A database block holds more than a table: typed columns, many rows. Text in a cell is cut shorter; a row's body is what the edit endpoint allows.
const DB_COLS=30,DB_ROWS=500,CELL=500,NAME=100,OPTIONS=100,DB_VIEWS=20,SORTS=10,ROW_BODY=20_000,FIELDS=20,BUTTONS=6,PROPS=20_000;
/** What a database block keeps when the page is read; the page's own table editor refuses more rather than have it vanish. */
export const DB_BLOCK_LIMITS={rows:DB_ROWS,columns:DB_COLS,views:DB_VIEWS,cell:CELL} as const;
// A database block is as forgiving as the rest: what does not fit is clipped or dropped, never a reason to lose the block.
/** A cell before its column's type has a say: text is cut to CELL characters, and what is not a cell value at all is empty. */
const dbCell=(v:unknown):CellValue=>{
  if(typeof v==='string')return clip(v,CELL);
  if(typeof v==='number')return Number.isFinite(v)?v:null;
  if(typeof v==='boolean')return v;
  if(Array.isArray(v))return v.slice(0,LIST*SCAN).map(x=>clip(cell(x),CELL)).filter(Boolean).slice(0,LIST);
  if(isObj(v)&&typeof v.start==='string')return {start:clip(v.start,NAME),...(typeof v.end==='string'&&v.end?{end:clip(v.end,NAME)}:{})};
  return null;
};
/** What the column's type makes of it: a select value outside the options, or one the type cannot hold, comes out empty. */
const dbValue=(c:Column,v:unknown):CellValue=>{const {value}=convertValue(dbCell(v),c.type,c.options);return typeof value==='string'&&c.type==='text'?clip(value,CELL):value};
/** A bare string is an option whose label is its value, which is what a person-made column has too. */
const dbOption=z.union([stext,z.object({value:stext,label:opt(str),color:opt(z.enum(OPTION_COLORS))})]).transform((o):ColumnOption=>{
  const {value,label,color}=typeof o==='string'?{value:o,label:undefined,color:undefined}:o,l=label?.trim();
  return {value:clip(value.trim(),SHORT),...(l?{label:clip(l,NAME)}:{}),...(color?{color}:{})};
});
const dbOptions=opt(list(dbOption,OPTIONS,0).transform(a=>{const seen=new Set<string>();return a.filter(o=>!seen.has(o.value)&&!!seen.add(o.value))}).refine(a=>a.length>0));
// A type that is not one of ours still keeps its words, as text. Name and id gaps are filled in once the list is known.
const dbColumn=z.object({id:z.unknown().transform(idOf),name:or(scalar,''),type:or(z.enum(COLUMN_TYPES),'text' as const),options:dbOptions,
  editable:opt(z.boolean()),width:opt(num.min(40).max(2000))});
const dbRow=z.object({id:z.unknown().transform(idOf),values:or(z.custom<Record<string,unknown>>(isObj),{} as Record<string,unknown>),body:opt(z.string())});
/** Columns a view names that the database does not have are dropped from it. A custom view keeps its component or code wherever it comes
 * from: it runs in the sandbox (spec 4.3), which the user accepted for agent-written code too. Code over CODE bytes is dropped, not cut:
 * half a script is no script. */
function dbView(cols:Set<string>){
  const col=z.unknown().transform(idOf).refine(x=>cols.has(x)),value=z.unknown().transform(v=>v===undefined?undefined:dbCell(v));
  const config=z.object({filters:or(list(z.object({column:col,op:z.enum(FILTER_OPS),value}),LIST,0),[]),match:or(z.enum(['all','any']),'all' as const),
    sorts:or(list(z.object({column:col,dir:z.enum(['asc','desc'])}),SORTS,0),[]),group:opt(col),visible:opt(list(col,DB_COLS,0).transform(a=>a.length?a:undefined)),
    date:opt(col),planDate:opt(col),cover:opt(col),component:opt(text.transform(s=>clip(s.trim(),ID))),code:opt(z.string().refine(codeFits))});
  return z.object({id:z.unknown().transform(idOf),name:or(scalar,''),type:z.enum(VIEW_TYPES),config:z.unknown().transform(v=>config.parse(isObj(v)?v:{}))});
}
/** Ids are made distinct and gaps filled (c0, r0, v0 by place); a row's values are read by the column ids as the model wrote them, then
 * keyed by the final ones. Rows keep their place whatever their cells hold. */
function buildDatabase(cols:z.output<typeof dbColumn>[],rawRows:unknown[],rawViews:unknown[]){
  const used=new Set<string>(),byKey=new Map<string,Column>();
  const columns=cols.map((c,i):Column=>{
    const column:Column={id:unique(used,c.id||`c${i}`),name:clip(c.name.trim(),NAME)||L(`列 ${i+1}`,`Column ${i+1}`),type:c.type,...(c.options?{options:c.options}:{}),
      ...(c.editable===undefined?{}:{editable:c.editable}),...(c.width===undefined?{}:{width:c.width})};
    if(c.id&&!byKey.has(c.id))byKey.set(c.id,column);
    return column;
  });
  const usedRows=new Set<string>(),rows=list(dbRow,DB_ROWS,0).parse(rawRows).map((r,i)=>{
    const values:Record<string,CellValue>={};
    for(const [k,v] of Object.entries(r.values).slice(0,DB_COLS*SCAN)){const c=byKey.get(idOf(k)),x=c&&dbValue(c,v);if(c&&x!==null&&x!==undefined)values[c.id]=x}
    return {id:unique(usedRows,r.id||`r${i}`),values,...(r.body?.trim()?{body:clip(r.body,ROW_BODY)}:{})};
  });
  const usedViews=new Set<string>(),ids=new Set(columns.map(c=>c.id));
  const views=list(dbView(ids),DB_VIEWS,0).parse(rawViews).map((v,i):View=>({...v,id:unique(usedViews,v.id||`v${i}`),name:clip(v.name.trim(),NAME)||L(`视图 ${i+1}`,`View ${i+1}`),position:i}));
  return {columns,rows,...(views.length?{views}:{})};
}
// No rows is a table waiting for its first one; no usable column leaves nothing to show.
const database:z.ZodType<DatabaseBlock&PageBlockMeta,z.ZodTypeDef,unknown>=block('database',{title:opt(str),columns:list(dbColumn,DB_COLS),rows:or(arr,[] as unknown[]),views:or(arr,[] as unknown[])})
  .transform(({columns,rows,views,...b})=>({...b,...buildDatabase(columns,rows,views)}));

const FIELD_TYPES=['text','number','select','date','checkbox'] as const;
/** A select without options has nothing to pick, so it asks for words instead; options mean nothing to any other field. */
const field=z.object({key:stext.transform(s=>clip(s.trim(),ID)),label:stext,type:or(z.enum(FIELD_TYPES),'text' as const),options:opt(list(stext,LIST,1,true)),required:opt(z.boolean())})
  .transform(({options,...f})=>f.type!=='select'?f:options?{...f,options}:{...f,type:'text' as const});
/** A component name as the library stores it (spec 4.3). */
const COMPONENT=/^[a-z][a-z0-9-]{1,40}$/;
const jsonSize=(v:unknown)=>{try{return JSON.stringify(v).length}catch{return Infinity}};

export const INTERACTIVE=[
  entry({type:'actions',category:'interactive',get label(){return L('按钮组','Buttons')},describe:'1-6 buttons; a click sends its prompt to the Desk assistant.',
    schema:block('actions',{buttons:list(z.object({label:stext,prompt:text}),BUTTONS)}),example:{type:'actions',buttons:[{label:'Draft reply',prompt:'Draft a reply to the vendor'}]}}),
  // Values are sent under their keys, so a second field with a key already taken would overwrite the first.
  entry({type:'form',category:'interactive',get label(){return L('表单','Form')},describe:'Fields (text, number, select with options, date, checkbox; required?) sent with prompt on submit.',
    schema:block('form',{title:text,fields:list(field,FIELDS).transform(a=>{const seen=new Set<string>();return a.filter(f=>!seen.has(f.key)&&!!seen.add(f.key))}),submitLabel:opt(stext),prompt:text}),
    example:{type:'form',title:'Trip',fields:[{key:'city',label:'City',type:'text',required:true}],prompt:'Plan a trip with these answers'}}),
  entry({type:'poll',category:'interactive',get label(){return L('投票','Poll')},describe:'A question with 2+ options, multi for several; the vote goes to the assistant.',
    schema:block('poll',{question:text,options:list(stext,LIST,2,true),multi:opt(z.boolean())}),example:{type:'poll',question:'Lunch?',options:['Ramen','Sushi']}}),
  entry({type:'database',category:'interactive',get label(){return L('数据库','Database')},
    describe:'Typed table. columns [{id, name, type: text, number, date, select, multi, checkbox, url, progress or image; options for select and multi}], '+
      'rows [{values keyed by column id}], views optional [{name, type: table, board, list, calendar, gallery, timeline or custom; config}].',
    schema:database,example:{type:'database',title:'Hotels',columns:[{id:'name',name:'Hotel',type:'text'},{id:'price',name:'Per night',type:'number'}],rows:[{id:'r1',values:{name:'Inn',price:120}}]}}),
  // Only the id is required: whether the database is still there is for whoever draws it to say.
  entry({type:'database-ref',category:'interactive',get label(){return L('数据库视图','Database view')},describe:'A database the user keeps, by its real id (never invent one), optionally in one of its views (viewId).',
    schema:block('database-ref',{databaseId:blockId,viewId:opt(blockId),title:opt(str)}),example:{type:'database-ref',databaseId:'db_trips'}}),
  // Exactly one source of code: a library component by name, or code written into the block; both or neither is a mistake, not a choice.
  entry({type:'custom',category:'interactive',get label(){return L('自定义组件','Custom component')},describe:'Your own HTML and JS in a sandbox: component (a saved name) or code (up to 200 KB), props, height 80-1600.',
    schema:block('custom',{component:maybe(z.string().regex(COMPONENT)),code:maybe(z.string().refine(codeFits)),props:maybe(z.custom<Record<string,unknown>>(isObj).refine(p=>jsonSize(p)<=PROPS)),height:opt(height(80,1600))})
      .refine(b=>(b.component===undefined)!==(b.code===undefined)),
    example:{type:'custom',code:'<p>Hi</p>',height:120}}),
] as const;
