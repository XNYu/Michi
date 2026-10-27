// Michi: native heading blocks use the default heading level.
import {createContext,useEffect,useRef} from 'react';
import {slotsOf,type PageBlockWithSources} from '../../../../../shared/desk-blocks';
import {segmentId,splitMarkdown} from '../../../../../shared/markdown-segments';

type Block=PageBlockWithSources;
/** Native grids use the same reading order without entering the vendor write catalog. */
const slots=(block:Block):Block[][]=>(block as {type:string}).type==='grid'
 ?(block as unknown as {regions:Array<{blocks:Block[]}>}).regions.map(region=>region.blocks):slotsOf(block);
const contains=(blocks:Block[],id:string):boolean=>blocks.some(block=>block.id===id||id.startsWith(`${block.id}~`)||slots(block).some(children=>contains(children,id)));
/** The page's blocks as drawn, for what reads the whole page (toc); null outside a project page, as in an assistant answer. */
export const PageBlocksContext=createContext<Block[]|null>(null);
export type Heading={id:string;level:number;text:string};
const words=(line:string)=>line.replace(/^ {0,3}#{1,6}[ \t]*/,'').replace(/[ \t]+#+[ \t]*$/,'').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/[*_`~]/g,'').trim();
/** Every heading block and every Markdown heading, in reading order, each named by the shell it is drawn in: a piece of top-level agent
 * Markdown (drawn cut up), else the whole block. */
export function outline(blocks:Block[],top=true):Heading[]{
 return blocks.flatMap((b):Heading[]=>{
  if(b.type==='heading')return [{id:b.id,level:b.level??2,text:b.text}];
  if(b.type!=='markdown')return slots(b).flatMap(s=>outline(s,false));
  const parts=splitMarkdown(b.text),cut=top&&!b.edit&&parts.length>1;
  return parts.filter(s=>s.kind==='heading').map(s=>({id:cut?segmentId(b.id,s.index):b.id,level:/^ {0,3}(#{1,6})/.exec(s.text)?.[1].length??1,text:words(s.text)})).filter(h=>h.text);
 });
}

const REVEAL='desk-reveal';
/** Asks the toggles and tabs around `id` to show it, before the page scrolls there. */
export const reveal=(id:string)=>window.dispatchEvent(new CustomEvent<string>(REVEAL,{detail:id}));
/** A container shows the slot holding a block about to be scrolled to (a piece of Markdown counts as its block). */
export function useReveal(slots:Block[][],show:(slot:number)=>void){
 const latest=useRef({slots,show});latest.current={slots,show};
 useEffect(()=>{
  const on=(event:Event)=>{
   const id=(event as CustomEvent<string>).detail,{slots,show}=latest.current;
   const at=slots.findIndex(s=>contains(s,id));if(at>=0)show(at);
  };
  window.addEventListener(REVEAL,on);return()=>window.removeEventListener(REVEAL,on);
 },[]);
}
