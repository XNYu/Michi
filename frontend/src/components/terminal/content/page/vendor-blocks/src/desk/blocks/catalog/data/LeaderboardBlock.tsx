import type {BlockProps} from '../../types';
import {fmt} from './format';

/** Highest value first, whatever order it came in; the first three are bold. */
export function LeaderboardBlock({block:{title,items},hid}:BlockProps<'leaderboard'>){
 return <>
  <h2 id={hid} className="desk-block-title">{title}</h2>
  <ol className="desk-lb">{items.toSorted((a,b)=>b.value-a.value).map((it,i)=><li key={i} className={i<3?'is-top':undefined}>
   <span className="desk-lb-rank">{i+1}</span>
   <span className="desk-lb-name">{it.name}{it.note&&<small>{it.note}</small>}</span>
   <span className="desk-lb-value">{fmt(it.value)}</span>
  </li>)}</ol>
 </>;
}
