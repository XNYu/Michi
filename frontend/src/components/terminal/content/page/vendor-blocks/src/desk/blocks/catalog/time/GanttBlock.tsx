import {useMemo} from 'react';
import {Bars,rangeOf,spanOf,todayNum,type Lane,type Span,type Zoom} from '../../../db/views/bars';
import type {BlockProps} from '../../types';
import {whenText} from './format';
import {Title} from './Title';
import './time.css';
import {L} from '../../../../../shared/i18n';

type Item=BlockProps<'gantt'>['block']['items'][number];
const pct=(n:number)=>`${Math.round(n*100)}%`;

/** A group is a heading lane with its items under it, in the order groups first appear. Items with no group come first and have no heading: after a
 * group's rows they would look like part of it. */
function lanesOf(items:Item[]):{lanes:Lane[];spans:Span[]}{
  const groups=new Map<string,{item:Item;span:Span}[]>(),spans:Span[]=[];
  for(const item of items){
    const span=spanOf({start:item.start,end:item.end});if(!span)continue;
    spans.push(span);const g=item.group??'',list=groups.get(g);if(list)list.push({item,span});else groups.set(g,[{item,span}]);
  }
  const lanes:Lane[]=[];let n=0;
  for(const [g,rows] of [...groups].sort((a,b)=>Number(a[0]!=='')-Number(b[0]!==''))){
    if(g)lanes.push({key:`g${n++}`,label:g,group:true});
    for(const {item,span} of rows){
      const from=whenText(item.start),to=whenText(item.end),when=from===to?from:`${from} → ${to}`;
      lanes.push({key:`i${n++}`,actual:span,done:item.done,title:L(`${item.label}：${when}${item.done===undefined?'':`，完成 ${pct(item.done)}`}`,`${item.label}: ${when}${item.done===undefined?'':`, ${pct(item.done)} done`}`),
        label:<><span className="desk-time-gantt-name" title={item.label}>{item.label}</span>{item.done!==undefined&&<span className="desk-bars-count">{pct(item.done)}</span>}</>});
    }
  }
  return {lanes,spans};
}

/** Read-only bars (db/views/bars): the zoom follows how long the whole plan is, the axis covers the plan and today only when today is near it. */
export function GanttBlock({block,hid}:BlockProps<'gantt'>){
  const {lanes,spans}=useMemo(()=>lanesOf(block.items),[block.items]);
  if(!spans.length)return null;
  const lo=Math.min(...spans.map(s=>s.start)),hi=Math.max(...spans.map(s=>s.end)),today=todayNum();
  const zoom:Zoom=hi-lo<21?'day':hi-lo<180?'week':'month';
  return <>
    <Title id={hid} text={block.title}/>
    <Bars lanes={lanes} zoom={zoom} range={rangeOf(spans,zoom,Math.min(Math.max(today,lo),hi))} today={today} label={block.title||L('甘特图','Gantt chart')}/>
  </>;
}
