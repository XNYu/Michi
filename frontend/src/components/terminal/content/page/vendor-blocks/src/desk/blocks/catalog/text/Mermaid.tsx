import {useEffect,useState} from 'react';
import type {BlockProps} from '../../types';
import './text.css';
import {L} from '../../../../../shared/i18n';

let ready=false,seq=0;
/** Mermaid, loaded when a diagram is first drawn, in strict mode (its own sanitizer, no click handlers or HTML labels). Michi's chat
 * block brings English controls and its own chrome, so the page draws its own. Parsed before it is drawn, so a bad diagram leaves
 * nothing behind; then the source shows instead. */
export function MermaidBlock({block}:BlockProps<'mermaid'>){
 const [out,setOut]=useState<{code:string;svg?:string;failed?:boolean}|null>(null);
 useEffect(()=>{
  let live=true;const id=`desk-mermaid-${++seq}`;
  import('mermaid').then(async({default:mermaid})=>{
   if(!ready){mermaid.initialize({startOnLoad:false,securityLevel:'strict'});ready=true;}
   await mermaid.parse(block.code);
   const {svg}=await mermaid.render(id,block.code);
   if(live)setOut({code:block.code,svg});
  }).catch(()=>{document.getElementById(`d${id}`)?.remove();if(live)setOut({code:block.code,failed:true});});
  return()=>{live=false;};
 },[block.code]);
 const shown=out?.code===block.code?out:null;
 if(shown?.svg)return <div className="desk-mermaid" role="img" aria-label={L('流程图','Flowchart')} dangerouslySetInnerHTML={{__html:shown.svg}}/>;
 return <div className="desk-mermaid-src">
  {shown?.failed&&<p className="desk-quiet">{L('这张图画不出来，下面是原文','This diagram couldn’t be drawn. Here is the source')}</p>}
  <pre><code>{block.code}</code></pre>
 </div>;
}
