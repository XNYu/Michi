import {MAX_DEPTH,slotsOf,walkBlocks,withSlots,type PageBlockWithSources} from './desk-blocks.ts';
import {SLOT} from './desk-catalog/fields.ts';
import {parseSegmentId,segmentId,splitMarkdown} from './markdown-segments.ts';
import {L} from './i18n.ts';

/** Spec 2.4 with containers: the page's blocks as a tree, changed the same way on the server (applyPageOps) and on screen ahead of it (applyLocal). */
type Block=PageBlockWithSources;
/** One list inside a container: a column, a tab, a toggle's body (slot 0). */
export type Slot={id:string;slot:number};
/** Where a block sits: the slot holding it (null: the page itself), its place there, and how deep (0 at the top). */
export type Place={block:Block;parent:Slot|null;index:number;depth:number};
/** Where something put down lands. */
export type Spot={at:Slot|null;index:number;depth:number};
export type Refusal='missing'|'self'|'inside'|'slot'|'deep'|'full';
// Getters, so the server says each in the language in force when it refuses.
export const REFUSED:Record<Exclude<Refusal,'missing'>,string>={get self(){return L('不能把块挪到它自己后面。',"A block can't move after itself.");},get inside(){return L('不能把块挪进它自己里面。',"A block can't move inside itself.");},
 get slot(){return L('这个容器没有这一栏。',"This container doesn't have that slot.");},get deep(){return L('容器里最多再套一层容器。','A container can hold only one more level of containers.');},get full(){return L(`一栏最多放 ${SLOT} 块。`,`A slot holds at most ${SLOT} blocks.`);}};

export const isContainer=(b:Block)=>b.type==='toggle'||b.type==='columns'||b.type==='tabs';
/** A container with nothing in any slot. */
export const isEmpty=(b:Block)=>isContainer(b)&&slotsOf(b).every(s=>!s.length);
export const sameSlot=(a:Slot|null,b:Slot|null)=>a===b||!!a&&!!b&&a.id===b.id&&a.slot===b.slot;
export function placeOf(blocks:readonly Block[],id:string,parent:Slot|null=null,depth=0):Place|undefined{
 for(const [index,block] of blocks.entries()){
  if(block.id===id)return {block,parent,index,depth};
  for(const [slot,list] of slotsOf(block).entries()){const p=placeOf(list,id,{id:block.id,slot},depth+1);if(p)return p;}
 }
 return undefined;
}
export const idsOf=(blocks:readonly Block[])=>{const ids=new Set<string>();walkBlocks(blocks,b=>{ids.add(b.id);});return ids;};
/** Levels a block needs under it: a container always one for its slots, even empty ones, so it never sits at the deepest level. */
export const heightOf=(b:Block):number=>isContainer(b)?1+Math.max(0,...slotsOf(b).flat().map(heightOf)):0;
const holds=(b:Block,id:string)=>!!placeOf(slotsOf(b).flat(),id);
/** The list a slot names, the page's own for null; undefined when there is no such slot. */
export function listAt(blocks:Block[],at:Slot|null):Block[]|undefined{
 if(!at)return blocks;
 const p=placeOf(blocks,at.id);return p?slotsOf(p.block)[at.slot]:undefined;
}
/** The tree with the list at `at` replaced by f of it; whatever is not on the way there is shared. */
export function editList(blocks:Block[],at:Slot|null,f:(list:Block[])=>Block[]):Block[]{
 if(!at)return f(blocks);
 let changed=false;
 const out=blocks.map(b=>{
  const slots=slotsOf(b);if(!slots.length)return b;
  const next=b.id===at.id?slots.map((s,i)=>i===at.slot?f(s):s):slots.map(s=>editList(s,at,f));
  if(next.every((s,i)=>s===slots[i]))return b;
  changed=true;return withSlots(b,next);
 });
 return changed?out:blocks;
}
/** Every block through f, what a container holds before the container. */
export const mapBlocks=(blocks:Block[],f:(b:Block)=>Block):Block[]=>blocks.map(b=>{const slots=slotsOf(b);return f(slots.length?withSlots(b,slots.map(s=>mapBlocks(s,f))):b);});
/** The blocks `keep` passes, judged after what they hold has been. */
export const filterBlocks=(blocks:Block[],keep:(b:Block)=>boolean):Block[]=>
 blocks.map(b=>{const slots=slotsOf(b);return slots.length?withSlots(b,slots.map(s=>filterBlocks(s,keep))):b;}).filter(keep);

/** Where something put after `after` lands: in the slot `parent` names (null: the page), or, with no parent given, in the list that holds
 * `after`; first in that list when `after` is null. */
export function spotFor(blocks:Block[],after:string|null,parent?:Slot|null):Spot|Refusal{
 let at:Slot|null=null;
 if(parent){
  const p=placeOf(blocks,parent.id);if(!p)return 'missing';
  if(!Number.isInteger(parent.slot)||parent.slot<0||parent.slot>=slotsOf(p.block).length)return 'slot';
  at={id:parent.id,slot:parent.slot};
 }else if(parent===undefined&&after!==null){const p=placeOf(blocks,after);if(!p)return 'missing';at=p.parent;}
 const list=listAt(blocks,at)!,i=after===null?-1:list.findIndex(b=>b.id===after);
 if(after!==null&&i<0)return 'missing';
 return {at,index:i+1,depth:at?placeOf(blocks,at.id)!.depth+1:0};
}
export const insertAt=(blocks:Block[],spot:Spot,block:Block)=>editList(blocks,spot.at,l=>[...l.slice(0,spot.index),block,...l.slice(spot.index)]);
export function removeAt(blocks:Block[],id:string):{blocks:Block[];from:Place}|undefined{
 const from=placeOf(blocks,id);if(!from)return undefined;
 return {blocks:editList(blocks,from.parent,l=>l.filter((_,i)=>i!==from.index)),from};
}
/** `id` taken out and put down after `after`, in `parent` when one is named. Refused when it would land inside itself, sit deeper than
 * MAX_DEPTH allows, or overfill a slot; the page itself has no such cap, since only adding is capped there. */
export function moveBlock(blocks:Block[],id:string,after:string|null,parent?:Slot|null):{blocks:Block[];from:Place}|Refusal{
 const from=placeOf(blocks,id);if(!from)return 'missing';
 if(after===id)return 'self';
 if(parent&&(parent.id===id||holds(from.block,parent.id))||after!==null&&holds(from.block,after))return 'inside';
 const rest=removeAt(blocks,id)!.blocks,spot=spotFor(rest,after,parent);
 if(typeof spot==='string')return spot;
 if(spot.depth+heightOf(from.block)>MAX_DEPTH)return 'deep';
 if(spot.at&&!sameSlot(spot.at,from.parent)&&listAt(rest,spot.at)!.length>=SLOT)return 'full';
 return {blocks:insertAt(rest,spot,from.block),from};
}
/** The block marked as the person's, anchored to the one now before it in its own list (null when it is first there). */
export function markEdited(blocks:Block[],id:string,at:number):Block[]{
 const p=placeOf(blocks,id);if(!p)return blocks;
 return editList(blocks,p.parent,l=>l.map((b,i)=>i===p.index?{...b,edit:{at,anchor:i?l[i-1].id:null}}:b));
}
/** A container a person emptied stays, marked theirs (which is what lets it validate empty), so there is still somewhere to drop into. */
export function keepEmptied(blocks:Block[],from:Slot|null,at:number):Block[]{
 const p=from?placeOf(blocks,from.id):undefined;
 return p&&isEmpty(p.block)?markEdited(blocks,p.block.id,at):blocks;
}
/** `<b>~<n>` names segment n of markdown block b until that segment is first touched; then b becomes one block per segment where it
 * stands, top level or in a container, so the touched piece can carry its own edit mark. A real block with that id, or no such
 * segment, leaves the blocks as they are (the same array). */
export function splitSegment(blocks:Block[],id:string):Block[]{
 const ids=idsOf(blocks);if(ids.has(id))return blocks;
 const seg=parseSegmentId(id),place=seg?placeOf(blocks,seg.blockId):undefined,block=place?.block;
 if(!seg||!place||!block||block.type!=='markdown')return blocks;
 const parts=splitMarkdown(block.text),pieceIds=parts.map((_,i)=>segmentId(block.id,i));
 if(seg.index>=parts.length||pieceIds.some(x=>ids.has(x)))return blocks;
 // Evidence covers the whole block, so every piece keeps it. A block the person wrote stays theirs piece by piece, each anchored to the one before.
 const pieces=parts.map((p,i):Block=>({id:pieceIds[i],type:'markdown',text:p.text,...(block.sources?{sources:block.sources}:{}),
  ...(block.edit?{edit:{at:block.edit.at,anchor:i?pieceIds[i-1]:block.edit.anchor}}:{}),...(i===0&&block.staleFor!==undefined?{staleFor:block.staleFor}:{})}));
 return editList(blocks,place.parent,l=>[...l.slice(0,place.index),...pieces,...l.slice(place.index+1)]);
}
