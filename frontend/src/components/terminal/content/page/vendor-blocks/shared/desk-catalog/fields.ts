import {z} from 'zod';
import type {PageBlockWithSources} from '../desk-blocks.ts';
/** Spec §5.3: a page is data the model writes, never markup. Every field here is forgiving the same way: what does not fit is clipped or
 * dropped, and only what a block cannot do without costs the block. */
export const STR=2000,ID=100,SHORT=200,LIST=50,SCAN=4,SOURCES=10,LONG=20_000,CODE=200_000,URL_MAX=2000,SLOT=20;
export const TONES=['info','warn','success','danger'] as const;
export const clip=(s:string,n=STR)=>s.length>n?s.slice(0,n).replace(/[\ud800-\udbff]$/,''):s;
/** UTF-8 bytes as Buffer.byteLength counts them (a lone surrogate is 3), without Buffer, so the page and the server hold code to the same CODE. */
export const utf8Bytes=(s:string)=>{let n=s.length;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c<0x80)continue;if(c<0x800){n++;continue;}
  n+=2;if(c>=0xd800&&c<=0xdbff&&(s.charCodeAt(i+1)&0xfc00)===0xdc00)i++;}return n;};
/** Code is held to CODE bytes, not characters: 200,000 characters of Chinese would be 600 KB. */
export const codeFits=(s:string)=>s.length<=CODE&&utf8Bytes(s)<=CODE;
export const isObj=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
const filled=(s:string)=>s.trim()!=='';
export const str=z.string().transform(s=>clip(s)),text=str.refine(filled),num=z.number().finite(),unit=num.transform(n=>Math.min(1,Math.max(0,n)));
/** Code, diagrams and diffs run longer than prose. */
export const long=z.string().transform(s=>clip(s,LONG)),longText=long.refine(filled);
/** Models often send a number where a label belongs; finite numbers become text, anything else non-string is rejected. */
export const scalar=z.union([str,num.transform(String)]),stext=scalar.refine(filled),arr=z.custom<unknown[]>(Array.isArray);
/** A table cell is never fatal: what is not text or a finite number is blank. */
export const cell=(v:unknown)=>{const r=scalar.safeParse(v);return r.success?r.data:''};
/** A bad optional field falls back to d instead of failing its block. */
export const or=<T extends z.ZodTypeAny,D>(t:T,d:D)=>z.unknown().transform((v):z.output<T>|D=>{const r=t.safeParse(v);return r.success?r.data:d});
export const opt=<T extends z.ZodTypeAny>(t:T)=>or(t,undefined);
/** A size is held to what the layout can show rather than refused. */
export const between=(lo:number,hi:number)=>num.transform(n=>Math.min(hi,Math.max(lo,n))),height=(lo:number,hi:number)=>between(lo,hi).transform(Math.round);
/** Bad items are dropped, the rest kept up to max; only the first max*4 are looked at, so junk costs little. Fewer than min leaves nothing worth showing, so the block goes. */
export const list=<T extends z.ZodTypeAny>(item:T,max:number,min=1,uniq=false)=>arr.transform(a=>{
  const out:z.output<T>[]=[],seen=uniq?new Set<unknown>():undefined,end=Math.min(a.length,max*SCAN);
  for(let i=0;i<end&&out.length<max;i++){const r=item.safeParse(a[i]);if(r.success&&!seen?.has(r.data)){out.push(r.data);seen?.add(r.data)}}
  return out;
}).refine(a=>a.length>=min);
/** Left out, null or blank: models say "none" all three ways. */
const absent=z.union([z.undefined(),z.null(),z.string().refine(s=>!filled(s))]).transform(():undefined=>undefined);
/** A field that may be missing but, when there, must be right: unlike `opt`, a bad value costs the block. */
export const maybe=<T extends z.ZodTypeAny>(t:T)=>absent.or(t);
const isHttps=(s:string)=>{try{const u=new URL(s);return u.protocol==='https:'&&u.hostname!==''}catch{return false}};
/** Spec 4.1: what a page loads or links to by itself goes over https only. A URL is never clipped, since a cut one points somewhere else. */
export const url=z.string().transform(s=>s.trim()).refine(s=>s.length<=URL_MAX&&isHttps(s)),optUrl=maybe(url);
const isDay=(s:string)=>{const d=new Date(`${s}T00:00:00Z`);return !Number.isNaN(d.getTime())&&d.toISOString().startsWith(s)};
/** A day that exists, as YYYY-MM-DD. */
export const day=z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isDay);
/** A day or an ISO date-time; a space before the time is read as the T models often leave out. */
export const instant=z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/).transform(s=>s.replace(' ','T'))
  .refine(s=>isDay(s.slice(0,10))&&Number.isFinite(Date.parse(s)));

/** Ids end up as keys and anchors: word characters, dot and dash only. Clipped before it is rewritten so a huge id costs nothing;
 * one with no letters or digits, or that names an Object member, counts as missing. */
const RESERVED=new Set(['__proto__','constructor','prototype']);
export const idOf=(v:unknown)=>{if(typeof v!=='string')return '';const s=clip(v.trim(),ID).replace(/[^\w.-]/g,'-');return /^[-._]*$/.test(s)||RESERVED.has(s)?'':s};
export const blockId=z.string().transform(idOf).refine(s=>s!=='');
/** `id` made distinct within `used`: a repeat becomes -2, -3... and still fits in ID characters. */
export const unique=(used:Set<string>,id:string)=>{const stem=id;for(let n=2;used.has(id);n++){const suffix=`-${n}`;id=stem.slice(0,ID-suffix.length)+suffix}used.add(id);return id};

/** The evidence behind a block's conclusion; hidden until asked for. */
export type BlockSource={sessionId:string;messageId?:string;path?:string};
/** Set once a person has changed the block. `anchor` is the id of the block before it, null at the top. */
export type BlockEdit={at:number;anchor:string|null};
/** `staleFor` marks a note the agent added to say the (person-edited) block it names may be out of date. */
export type PageBlockMeta={sources?:BlockSource[];edit?:BlockEdit;staleFor?:string};
const source=z.object({sessionId:text,messageId:opt(str),path:opt(str)});
// A malformed edit mark or note target costs only that field. Whether staleFor names a block of the page is checked once all ids are final.
export const base={id:z.unknown().transform(idOf),sources:opt(list(source,SOURCES,0).transform(a=>a.length?a:undefined)),
  edit:opt(z.object({at:num,anchor:z.union([z.null(),blockId])})),staleFor:opt(blockId)};
export const block=<T extends string,S extends z.ZodRawShape>(type:T,shape:S)=>z.object({...base,type:z.literal(type),...shape});

/** zod 3 passes no context into a parse, so what reading a block needs from around it is held here for one synchronous read (index.ts
 * sets it): the known thread ids, ids the page will get back, how deep the block sits, how many more blocks the page takes, and how to
 * read a child, which index.ts plugs in because the containers are defined before it. Outside a read, any thread passes. */
export const scope:{threadIds?:ReadonlySet<string>;kept?:ReadonlySet<string>;depth:number;left:number;child:(raw:unknown)=>PageBlockWithSources|null}=
  {depth:0,left:Infinity,child:()=>null};
export const known=(id:string)=>!scope.threadIds||scope.threadIds.has(id);
/** One slot of a container: its blocks, each read a level down and dropped like a bad list item when it does not hold. */
export const kids=(max:number):z.ZodType<PageBlockWithSources[],z.ZodTypeDef,unknown>=>arr.transform(a=>{
  const out:PageBlockWithSources[]=[];scope.depth++;
  try{for(let i=0,end=Math.min(a.length,max*SCAN);i<end&&out.length<max;i++){const b=scope.child(a[i]);if(b)out.push(b)}}finally{scope.depth--}
  return out;
});

export type Category='text'|'data'|'chart'|'time'|'media'|'interactive';
/** `describe` is English, for the agent; `label` is Chinese, for the「+」menu. A container holds blocks of its own. */
export type CatalogEntry<T extends string=string>={type:T;category:Category;label:string;describe:string;schema:z.ZodTypeAny;example:unknown;container?:true};
/** Keeps the schema's own type, which PageBlock is read from, and checks that it makes blocks of the entry's type. */
export const entry=<T extends string,S extends z.ZodType<{type:T},z.ZodTypeDef,unknown>>(e:{type:T;category:Category;label:string;describe:string;schema:S;example:unknown;container?:true})=>e;
