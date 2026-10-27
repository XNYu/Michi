import {Suspense,lazy} from 'react';
import type {BlockProps} from '../../types';
import {L} from '../../../../../shared/i18n';

// recharts comes with the first chart or trend line drawn, in the charts' own chunk, not with the page.
const StatSpark=lazy(()=>import('../chart/kinds').then(m=>({default:m.StatSpark})));
type Tone='up'|'down'|'flat';
const ARROW:Record<Tone,string>={up:'↑',down:'↓',flat:'→'},WORD:Record<Tone,string>=L({up:'上升',down:'下降',flat:'持平'},{up:'Up',down:'Down',flat:'Unchanged'});
/** A delta the page's writer signed but gave no tone still points the way its sign says. */
const toneOf=(delta:string,tone?:Tone):Tone=>tone??(/^\s*\+/.test(delta)?'up':/^\s*[-−–]/.test(delta)?'down':'flat');
/** One big figure. Accent for up, amber for down, grey for flat: a direction, not a verdict, since down can be good news. */
export function StatBlock({block:{label,value,delta,deltaTone,spark}}:BlockProps<'stat'>){
 const tone=delta?toneOf(delta,deltaTone):'flat';
 return <div className="desk-stat">
  <div className="desk-stat-label">{label}</div>
  <div className="desk-stat-value">{value}</div>
  {delta&&<div className={`desk-stat-delta is-${tone}`}><span aria-hidden="true">{ARROW[tone]}</span><span className="desk-sr">{WORD[tone]}</span> {delta}</div>}
  {spark&&<>
   {/* recharts makes its drawing a tab stop; inert keeps it out, and the numbers are said in words instead. */}
   <div className="desk-stat-spark" aria-hidden="true" inert><Suspense fallback={<div style={{height:40}}/>}><StatSpark data={spark}/></Suspense></div>
   <span className="desk-sr">{L('近期走势：','Recent trend: ')}{spark.join(L('、',', '))}</span>
  </>}
 </div>;
}
