import {Timeline} from '@mantine/core';
import {Check} from 'lucide-react';
import type {ReactNode} from 'react';
import type {BlockProps} from '../../types';
import {whenText} from './format';
import {Title} from './Title';
import './time.css';
import {L} from '../../../../../shared/i18n';

/** Status colours mean status only: 停住 amber and 做完 green; info is the one accent, no tone a quiet grey. */
const TONE={info:'var(--accent)',warn:'var(--desk-stalled,#d97706)',success:'var(--desk-done,#16a34a)',danger:'var(--danger)'};
const TONE_NAME=L({info:'提示',warn:'注意',success:'已完成',danger:'出问题'},{info:'Note',warn:'Caution',success:'Done',danger:'Problem'});
const GREY='var(--soft,#a1a1aa)';
// Every item is "active" so its ring takes its own colour; time.css keeps the line between items grey.
const look=(count:number)=>({active:count,bulletSize:16,lineWidth:2,role:'list',classNames:{root:'desk-time',item:'desk-time-item',itemBullet:'desk-time-bullet'}});
const Head=({title,when}:{title:string;when:string})=><span className="desk-time-head"><span className="desk-time-title">{title}</span><span className="desk-time-at">{when}</span></span>;

export function TimelineBlock({block,hid}:BlockProps<'timeline'>){
  return <>
    <Title id={hid} text={block.title}/>
    <Timeline {...look(block.items.length)}>
      {block.items.map((it,i)=><Timeline.Item key={i} role="listitem" color={it.tone?TONE[it.tone]:GREY} title={<Head title={it.title} when={whenText(it.at)}/>}>
        {it.tone&&<span className="desk-sr">{TONE_NAME[it.tone]}</span>}
        {it.text&&<p className="desk-time-text">{it.text}</p>}
      </Timeline.Item>)}
    </Timeline>
  </>;
}

/** Done milestones are filled with a tick, the ones still to come stay hollow. */
export function MilestonesBlock({block,hid}:BlockProps<'milestones'>){
  const tick:ReactNode=<Check size={11} strokeWidth={3} aria-hidden="true"/>;
  return <>
    <Title id={hid} text={block.title}/>
    <Timeline {...look(block.items.length)}>
      {block.items.map((m,i)=><Timeline.Item key={i} role="listitem" color={m.done?TONE.success:GREY} bullet={m.done?tick:undefined} title={<Head title={m.label} when={whenText(m.date)}/>}>
        <span className="desk-sr">{m.done?L('已完成','Done'):L('还没完成','Not done yet')}</span>
      </Timeline.Item>)}
    </Timeline>
  </>;
}
