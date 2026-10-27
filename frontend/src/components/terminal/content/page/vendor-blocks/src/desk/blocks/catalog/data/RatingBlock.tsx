import {Rating} from '@mantine/core';
import type {BlockProps} from '../../types';

/** Quarter stars, so 4.3 reads as about four and a quarter; the score beside them is exact. */
export function RatingBlock({block:{title,items},hid}:BlockProps<'rating'>){
 return <>
  {title&&<h2 id={hid} className="desk-block-title">{title}</h2>}
  <ul className="desk-rate">{items.map((it,i)=>{
   const score=String(Math.round(it.score*10)/10);
   return <li key={i}>
    <span className="desk-rate-label">{it.label}</span>
    <span role="img" aria-label={`${it.label} ${score} / 5`} className="desk-rate-stars"><Rating readOnly value={it.score} fractions={4} size={16} color="var(--accent)"/></span>
    <span className="desk-rate-score" aria-hidden="true">{score}</span>
   </li>;
  })}</ul>
 </>;
}
