import {useMemo} from 'react';
import type {BlockProps} from '../../types';
import {diffLines} from './diff-lines';
import './text.css';
import {L} from '../../../../../shared/i18n';

const MARK={same:' ',add:'+',del:'−'} as const,SAID=L({same:'',add:'加了：',del:'删了：'},{same:'',add:'Added: ',del:'Removed: '});
export function DiffBlock({block,hid}:BlockProps<'diff'>){
 const rows=useMemo(()=>diffLines(block.before,block.after),[block.before,block.after]);
 return <>
  {block.title&&<h2 id={hid} className="desk-block-title">{block.title}</h2>}
  <pre className="desk-diff"><code>{rows.map((r,i)=><span key={i} className="desk-diff-line" data-kind={r.kind}>
   <span className="desk-diff-mark" aria-hidden="true">{MARK[r.kind]}</span>{SAID[r.kind]&&<span className="desk-sr">{SAID[r.kind]}</span>}{r.text}
  </span>)}</code></pre>
 </>;
}
