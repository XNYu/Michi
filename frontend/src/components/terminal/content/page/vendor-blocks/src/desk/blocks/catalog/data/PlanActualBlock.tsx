import type {BlockProps} from '../../types';
import {fmt} from './format';
import {L} from '../../../../../shared/i18n';

/** The amber of overrun; the text beside the bar says the same in words. */
export const OVERRUN='#d97706';
/** Two bars an item, plan then actual. What the actual bar has beyond the plan is amber. Items in one unit share a scale so bars compare across rows;
 * with mixed units (money next to days) no scale is shared, and each item's longer bar fills its track. */
export function PlanActualBlock({block:{title,items},hid}:BlockProps<'plan-actual'>){
 const same=new Set(items.map(i=>i.unit)).size===1,top=Math.max(...items.map(i=>Math.max(i.planned,i.actual)));
 return <>
  <h2 id={hid} className="desk-block-title">{title}</h2>
  <ul className="desk-pa">{items.map((it,i)=>{
   const plan=Math.max(0,it.planned),actual=Math.max(0,it.actual),over=Math.max(0,actual-plan),scale=same?top:Math.max(plan,actual);
   const w=(n:number)=>({width:scale>0?`${n/scale*100}%`:'0%'}),f=(n:number)=>`${fmt(n)}${it.unit?` ${it.unit}`:''}`;
   return <li key={i} className="desk-pa-row">
    <div className="desk-pa-head"><span className="desk-pa-name">{it.label}</span>
     <span className="desk-pa-nums">{L('计划 ','Planned ')}{f(it.planned)}{L(' · 实际 ',' · actual ')}{f(it.actual)}{over>0&&<em className="desk-pa-excess">{L(' · 超出 ',' · over by ')}{f(over)}</em>}</span></div>
    <div className="desk-pa-track is-plan" aria-hidden="true"><span style={w(plan)}/></div>
    <div className="desk-pa-track" aria-hidden="true"><span style={w(Math.min(actual,plan))}/>{over>0&&<span className="desk-pa-over" style={{...w(over),background:OVERRUN}}/>}</div>
   </li>;
  })}</ul>
 </>;
}
