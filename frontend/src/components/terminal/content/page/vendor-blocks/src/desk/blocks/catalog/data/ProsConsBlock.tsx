import {Check,X} from 'lucide-react';
import type {BlockProps} from '../../types';
import {L} from '../../../../../shared/i18n';

const Side=({kind,head,items}:{kind:'pro'|'con';head:string;items:string[]})=>items.length>0&&<div className={`desk-pc-side is-${kind}`}>
 <h3 className="desk-pc-head">{head}</h3>
 <ul>{items.map((t,i)=><li key={i}><span className="desk-pc-mark" aria-hidden="true">{kind==='pro'?<Check size={14} strokeWidth={2.5}/>:<X size={14} strokeWidth={2.5}/>}</span>{t}</li>)}</ul>
</div>;
/** Two lists, ✓ and ✗; a side with nothing is left out rather than drawn empty. */
export const ProsConsBlock=({block:{title,pros,cons},hid}:BlockProps<'pros-cons'>)=><>
 {title&&<h2 id={hid} className="desk-block-title">{title}</h2>}
 <div className="desk-pc"><Side kind="pro" head={L('优点','Pros')} items={pros}/><Side kind="con" head={L('缺点','Cons')} items={cons}/></div>
</>;
