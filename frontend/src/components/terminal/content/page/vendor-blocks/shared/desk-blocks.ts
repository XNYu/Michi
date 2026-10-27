import type {Column} from './desk-db.ts';
import {MAX_BLOCKS,MAX_DEPTH,MAX_TOTAL_BLOCKS,readWith,settleIds,slotsOf,validateBlock,withSlots,type CatalogBlock} from './desk-catalog/index.ts';
import {SCAN,SHORT,clip,isObj,type BlockEdit,type BlockSource,type PageBlockMeta} from './desk-catalog/fields.ts';
import {DB_BLOCK_LIMITS} from './desk-catalog/interactive.ts';
/** Spec §5.3 and 4.2: a project page is data the model writes, never markup. Only the catalog's block types render; everything else is dropped. */
export type PageBlock=CatalogBlock;
export type {BlockEdit,BlockSource,PageBlockMeta};
export type PageBlockWithSources=PageBlock&PageBlockMeta;
export type ProjectPage={projectId:string;headline:string;blocks:PageBlockWithSources[];generatedAt:number;basis:string};
export {MAX_BLOCKS,MAX_DEPTH,MAX_TOTAL_BLOCKS,slotsOf,validateBlock,withSlots};

/** Where a block sits: the container holding it (null at the top), which of its slots, and its place there. */
export type BlockPlace={block:PageBlockWithSources;parent:PageBlockWithSources|null;slot:number;index:number};
/** Every block, a container before what it holds. */
export function walkBlocks(blocks:readonly PageBlockWithSources[],fn:(block:PageBlockWithSources,parent:PageBlockWithSources|null,slot:number,index:number)=>void){
  const walk=(list:readonly PageBlockWithSources[],parent:PageBlockWithSources|null,slot:number)=>list.forEach((b,i)=>{fn(b,parent,slot,i);slotsOf(b).forEach((s,j)=>walk(s,b,j));});
  walk(blocks,null,0);
}
export function findBlock(blocks:readonly PageBlockWithSources[],id:string,parent:PageBlockWithSources|null=null,slot=0):BlockPlace|undefined{
  for(const [index,block] of blocks.entries()){
    if(block.id===id)return {block,parent,slot,index};
    for(const [j,s] of slotsOf(block).entries()){const found=findBlock(s,id,block,j);if(found)return found;}
  }
  return undefined;
}
export const countBlocks=(blocks:readonly PageBlockWithSources[])=>{let n=0;walkBlocks(blocks,()=>{n++;});return n;};
const NAMES=['title','question','label','name','caption','alt','text'];
/** Fields that say nothing to a person about what the block is. */
const NOT_NAMES=new Set(['id','type','sources','edit','staleFor','url','image','avatar','before','after','code','databaseId','viewId','threadId','component','lang']);
/** What to call a block no one has written a handle for: its title, question, label or name, else its first words; '' when it has none. */
export function looseTitle(b:object):string{
  const o=b as Record<string,unknown>,pick=(k:string)=>typeof o[k]==='string'&&o[k].trim()?o[k].trim():'';
  return NAMES.map(pick).find(Boolean)||Object.keys(o).filter(k=>!NOT_NAMES.has(k)).map(pick).find(Boolean)||'';
}

/** Checks whatever the model sent against the catalog. Malformed blocks are dropped one by one; null means the page is unusable.
 * Only the first 160 raw blocks (MAX_BLOCKS*SCAN) are looked at, so a valid block after that window is ignored; lists get max*4 items.
 * Containers count their blocks against MAX_TOTAL_BLOCKS, and ids are made distinct across the whole tree.
 * threadIds, when given, limits thread cards to threads that exist. projectId and generatedAt are never taken from the model. */
export function validatePage(raw:unknown,projectId:string,now:number,threadIds?:Set<string>,kept?:ReadonlySet<string>):ProjectPage|null{
  if(!isObj(raw)||typeof raw.headline!=='string')return null;
  const headline=clip(raw.headline.trim(),SHORT);
  if(!headline)return null;
  const input=Array.isArray(raw.blocks)?raw.blocks:[],used=new Set<string>(),blocks:PageBlockWithSources[]=[];
  readWith({threadIds,kept,left:MAX_TOTAL_BLOCKS},read=>{
    for(let i=0,end=Math.min(input.length,MAX_BLOCKS*SCAN);i<end&&blocks.length<MAX_BLOCKS;i++){const b=read(input[i]);if(b)blocks.push(settleIds(b,used,`b${i}`));}
  });
  if(!blocks.length)return null;
  // Whether staleFor names a block of the page can only be told once every id is final.
  walkBlocks(blocks,b=>{if(b.staleFor!==undefined&&!used.has(b.staleFor)&&!kept?.has(b.staleFor))delete b.staleFor;});
  const page:ProjectPage={projectId,headline,blocks,generatedAt:now,basis:typeof raw.basis==='string'?clip(raw.basis.trim(),SHORT):''};
  // The round trip drops the undefined left by rejected optional fields, so the page is plain JSON.
  return JSON.parse(JSON.stringify(page)) as ProjectPage;
}

/** A legacy table as a database whose columns are all text, so it sorts and filters like any other. Ids are by place: c0, r0. */
export function tableAsDatabase(b:Extract<PageBlock,{type:'table'}>):Extract<PageBlock,{type:'database'}>{
  const columns=b.columns.map((name,i):Column=>({id:`c${i}`,name,type:'text'}));
  return {id:b.id,type:'database',...(b.title?{title:b.title}:{}),columns,
    rows:b.rows.map((r,i)=>({id:`r${i}`,values:Object.fromEntries(columns.flatMap((c,j)=>r[j]?[[c.id,r[j]]]:[]))}))};
}
/** Whether it becomes an Agent table without losing words: those keep shorter cells than a legacy table could hold. */
export const tableFits=(b:Extract<PageBlock,{type:'table'}>)=>b.rows.every(r=>r.every(c=>c.length<=DB_BLOCK_LIMITS.cell));
