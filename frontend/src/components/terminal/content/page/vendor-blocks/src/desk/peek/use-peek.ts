// Michi shim for agent-desk src/desk/peek/use-peek.ts: only what the contents block (Toc.tsx) calls. Blocks are
// found by Michi's own markers (BlockFrame's data-block-id, a Markdown piece's data-segment-of) and lit with the
// page's data-flash, as a link to a block lights it (DeskDocument.tsx).
import {parseSegmentId} from '../../../shared/markdown-segments';
import {reveal} from '../blocks/catalog/text/outline';
const MICHI_BLOCK_FLASH_MS = 600;

/** What block `id` is drawn as on this page: its shell, else the pieces Michi cut its Markdown into. Desk cuts only top-level Markdown
 * (outline.ts names a heading inside a container by its whole block); Michi cuts it in containers too, so such a heading lands on its
 * block's pieces, which light up together as one block. A piece Michi drew whole lands on its block. Ids hold ':' and '/', so they are
 * compared rather than put in a selector. */
function shellsOf(root:ParentNode,id:string):HTMLElement[]{
 const all=[...root.querySelectorAll<HTMLElement>('[data-block-id],[data-segment-of]')];
 const own=all.find(el=>el.dataset.blockId===id);
 if(own)return [own];
 const pieces=all.filter(el=>el.dataset.segmentOf===id);
 if(pieces.length)return pieces;
 const piece=parseSegmentId(id);
 return piece?shellsOf(root,piece.blockId):[];
}
/** A toggle folded shut keeps its blocks on the page, hidden; each one around the block opens. */
function unfold(el:HTMLElement){
 for(let d=el.closest('details');d;d=d.parentElement?.closest('details')??null)d.open=true;
}
/** The rest of what `flashBlock` lights with a block handed over by whenRevealed. */
const together=new WeakMap<HTMLElement,HTMLElement[]>();

/** Scrolls to a block and lights it up for a moment; returns what puts it out early. */
export function flashBlock(el:HTMLElement){
 const lit=together.get(el)??[el];together.delete(el);
 el.scrollIntoView?.({block:'center'});for(const e of lit)e.setAttribute('data-flash','');
 const timer=setTimeout(()=>{for(const e of lit)e.removeAttribute('data-flash');},MICHI_BLOCK_FLASH_MS);
 return()=>{clearTimeout(timer);for(const e of lit)e.removeAttribute('data-flash');};
}
/** Hands over block `id` once it is drawn, opening the toggles around it and asking a tab that holds it to show (outline.ts reveal), looking
 * again for a few frames; `missing` runs when it never shows. Returns what stops the looking. */
const TRIES=30;
export function whenRevealed(root:ParentNode,id:string,then:(el:HTMLElement)=>void,missing?:()=>void){
 let left=TRIES,live=true;
 const look=()=>{
  if(!live)return;
  const found=shellsOf(root,id);
  if(found.length){unfold(found[0]);together.set(found[0],found);then(found[0]);return;}
  if(left--<=0){missing?.();return;}
  reveal(id);requestAnimationFrame(look);
 };
 look();
 return()=>{live=false;};
}
