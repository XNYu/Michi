import {useEffect,useState} from 'react';
import type {BlockProps} from '../../types';
import './text.css';

/** KaTeX, loaded when a formula is first drawn. It never trusts the TeX (no \href, \htmlClass...) and draws what it cannot parse in red
 * instead of throwing; until it has loaded, the source shows. */
export function MathBlock({block}:BlockProps<'math'>){
 const [html,setHtml]=useState<{tex:string;display:boolean;html:string}|null>(null),display=!!block.display;
 useEffect(()=>{
  let live=true;
  void Promise.all([import('katex'),import('katex/dist/katex.min.css')]).then(([{default:katex}])=>{
   if(live)setHtml({tex:block.tex,display,html:katex.renderToString(block.tex,{throwOnError:false,trust:false,strict:'ignore',displayMode:display})});
  },()=>{});
  return()=>{live=false;};
 },[block.tex,display]);
 const ready=html&&html.tex===block.tex&&html.display===display?html.html:null;
 return ready===null?<code className="desk-math-src">{block.tex}</code>:<div className="desk-math" data-display={display||undefined} dangerouslySetInnerHTML={{__html:ready}}/>;
}
