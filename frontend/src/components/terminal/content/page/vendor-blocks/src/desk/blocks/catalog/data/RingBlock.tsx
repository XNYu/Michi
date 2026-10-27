import {RingProgress} from '@mantine/core';
import type {BlockProps} from '../../types';
import {pct} from './format';

/** Rings side by side; one that has reached its goal turns done-green. */
export function RingBlock({block:{title,items},hid}:BlockProps<'ring'>){
 return <>
  {title&&<h2 id={hid} className="desk-block-title">{title}</h2>}
  <ul className="desk-rings">{items.map((it,i)=><li key={i} className="desk-ring">
   <div role="progressbar" aria-label={it.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(it.value*100)}>
    <RingProgress size={84} thickness={8} rootColor="var(--subtle)" sections={[{value:it.value*100,color:it.value>=1?'var(--desk-done)':'var(--accent)'}]}
     label={<span className="desk-ring-pct">{pct(it.value)}</span>}/>
   </div>
   <span className="desk-ring-label">{it.label}</span>
  </li>)}</ul>
 </>;
}
