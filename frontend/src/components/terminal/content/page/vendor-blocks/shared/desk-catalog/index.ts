import type {z} from 'zod';
import type {PageBlockWithSources} from '../desk-blocks.ts';
import {ID,clip,isObj,scope,unique,type CatalogEntry,type Category,type PageBlockMeta} from './fields.ts';
import {TEXT} from './text.ts';
import {DATA,TABLE} from './data.ts';
import {CHART} from './chart.ts';
import {TIME} from './time.ts';
import {MEDIA} from './media.ts';
import {INTERACTIVE} from './interactive.ts';
export {CHART_KINDS,CHART_KIND_LABELS,type ChartKind} from './chart.ts';
export type {CatalogEntry,Category};

/** Top-level blocks a page holds, blocks counting those inside containers, and how deep a block may sit (0 is the page itself). */
export const MAX_BLOCKS=40,MAX_TOTAL_BLOCKS=120,MAX_DEPTH=2;
const ENTRIES=[...TEXT,...DATA,...CHART,...TIME,...MEDIA,...INTERACTIVE] as const;
/** Spec 4.1: the closed set of blocks the page agent and the assistant may write, in the order the「+」menu lists them. */
export const CATALOG:readonly CatalogEntry[]=ENTRIES;
/** Still read, so old pages keep working, but offered nowhere. */
export const LEGACY:readonly CatalogEntry[]=[TABLE];
type Strip<T>=T extends unknown?Omit<T,keyof PageBlockMeta>:never;
/** Every block a page can hold, as its schema reads it, without the meta fields every block shares. */
export type CatalogBlock=Strip<z.output<(typeof ENTRIES)[number]['schema']|typeof TABLE['schema']>>;
// A Map, so a type named after an Object member finds nothing.
const BY_TYPE=new Map<string,CatalogEntry>([...CATALOG,...LEGACY].map(e=>[e.type,e]));
export const entryOf=(type:string)=>BY_TYPE.get(type);
export const catalogTypes=()=>CATALOG.map(e=>e.type);

const HEADINGS:Record<Category,string>={text:'Text and structure',data:'Data and metrics',chart:'Charts',time:'Time',media:'Media and links',interactive:'Interactive'};
/** The limits every block obeys, which the assistant is told inline even when it reads each block's parameters on demand. */
export const CATALOG_RULES=`Blocks are JSON objects whose "type" is one of those below; anything else is dropped. Any block may carry an "id" (letters, digits, . _ -). `+
  `toggle, columns and tabs hold blocks of their own, nested at most ${MAX_DEPTH} levels deep. A page holds at most ${MAX_BLOCKS} top-level blocks and ${MAX_TOTAL_BLOCKS} in all. `+
  'Every url, image and avatar must be https or the block is dropped.';
/** What the page agent is told (Tasks 29, 33): one line per block and its example, grouped as the「+」menu groups them. */
export function catalogDoc():string{
  return [CATALOG_RULES,...(Object.keys(HEADINGS) as Category[]).map(c=>[`## ${HEADINGS[c]}`,...CATALOG.filter(e=>e.category===c).map(e=>`${e.type} — ${e.describe}\n${JSON.stringify(e.example)}`)].join('\n'))].join('\n\n');
}

/** One raw block by its entry, ids cleaned but not yet made distinct ('' when unusable). Too deep, past what the page still takes, or
 * not in the catalog, it is null. A block holds its own place before its children take theirs, and one that fails gives all of it back. */
function read(raw:unknown):PageBlockWithSources|null{
  if(scope.depth>MAX_DEPTH||scope.left<=0||!isObj(raw)||typeof raw.type!=='string')return null;
  const e=BY_TYPE.get(raw.type);if(!e)return null;
  const left=scope.left;scope.left--;
  const r=e.schema.safeParse(raw);
  if(!r.success){scope.left=left;return null}
  const b=r.data as PageBlockWithSources;
  // `kept` names blocks that are not in this output but will be on the page (the person-edited ones a regeneration puts back); a
  // staleFor naming one exactly is taken as is, since such ids may hold `~`.
  return typeof raw.staleFor==='string'&&scope.kept?.has(raw.staleFor)?{...b,staleFor:raw.staleFor}:b;
}
scope.child=read;
export type ReadOptions={threadIds?:ReadonlySet<string>;kept?:ReadonlySet<string>;/** How deep the block will sit. */depth?:number;/** Blocks it may hold, itself included. */left?:number};
/** Runs `f` with `read` set up for one page or block: `threadIds` limits thread cards to threads that exist. */
export function readWith<T>(o:ReadOptions,f:(read:(raw:unknown)=>PageBlockWithSources|null)=>T):T{
  const saved={threadIds:scope.threadIds,kept:scope.kept,depth:scope.depth,left:scope.left};
  Object.assign(scope,{threadIds:o.threadIds,kept:o.kept,depth:o.depth??0,left:o.left??MAX_TOTAL_BLOCKS});
  try{return f(read)}finally{Object.assign(scope,saved)}
}

/** A container's child lists, one per slot (a column, a tab; a toggle has one); none for any other block. */
export function slotsOf(b:PageBlockWithSources):PageBlockWithSources[][]{
  return b.type==='toggle'?[b.blocks]:b.type==='columns'?b.columns:b.type==='tabs'?b.tabs.map(t=>t.blocks):[];
}
/** The same container with its slots replaced, given in slotsOf order; any other block as it is. */
export function withSlots(b:PageBlockWithSources,slots:PageBlockWithSources[][]):PageBlockWithSources{
  return b.type==='toggle'?{...b,blocks:slots[0]??[]}:b.type==='columns'?{...b,columns:slots}:b.type==='tabs'?{...b,tabs:b.tabs.map((t,i)=>({...t,blocks:slots[i]??[]}))}:b;
}
/** The ids inside `b` made distinct within `used`, parent before children; a child without one is named after its parent and place (`a.0`). */
export function settleChildren(b:PageBlockWithSources,used:Set<string>):PageBlockWithSources{
  const slots=slotsOf(b);if(!slots.length)return b;
  let k=0;
  return withSlots(b,slots.map(s=>s.map(c=>settleIds(c,used,clip(`${b.id||'b'}.${k++}`,ID)))));
}
export const settleIds=(b:PageBlockWithSources,used:Set<string>,fallback:string)=>settleChildren({...b,id:unique(used,b.id||fallback)},used);

/** One block by the catalog's rules, as a person or the assistant sent it. Its own id comes back cleaned, '' when missing, since the
 * caller assigns it; the ids inside it are made distinct. A number is the depth it will sit at; past MAX_DEPTH nothing is read. */
export function validateBlock(raw:unknown,opts:number|Omit<ReadOptions,'left'>={}):PageBlockWithSources|null{
  const b=readWith(typeof opts==='number'?{depth:opts}:opts,read=>read(raw));if(!b)return null;
  // The round trip drops the undefined left by rejected optional fields, so the block is plain JSON.
  return JSON.parse(JSON.stringify(settleChildren(b,new Set(b.id?[b.id]:[])))) as PageBlockWithSources;
}
