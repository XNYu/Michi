import {useMemo} from 'react';
import {Tooltip} from '@mantine/core';
import {Month} from '@mantine/dates';
import 'dayjs/locale/zh-cn';
import type {BlockProps} from '../../types';
import {today} from '../../../db/db-ui';
import {Title} from './Title';
import './time.css';
import {L} from '../../../../../shared/i18n';

const dayName=(date:string)=>L(`${+date.slice(5,7)}月${+date.slice(8)}日`,new Date(+date.slice(0,4),+date.slice(5,7)-1,+date.slice(8,10)).toLocaleDateString('en-US',{month:'short',day:'numeric'}));

/** A month, Monday first. A day with events has a dot under its number; hovering or focusing it lists them. The schema already dropped events
 * outside the month, since the month is all that is drawn. */
export function CalendarBlock({block,hid}:BlockProps<'calendar'>){
  const byDay=useMemo(()=>{
    const days=new Map<string,string[]>();
    for(const e of block.events){const list=days.get(e.date);if(list)list.push(e.title);else days.set(e.date,[e.title]);}
    return days;
  },[block.events]);
  const now=today();
  const renderDay=(date:string)=>{
    const titles=byDay.get(date),num=<span className="desk-time-cal-num" data-today={date===now||undefined}>{+date.slice(8)}</span>;
    if(!titles)return num;
    return <Tooltip multiline maw={260} withArrow events={{hover:true,focus:true,touch:true}}
      label={<ul className="desk-time-cal-tip">{titles.map((t,i)=><li key={i}>{t}</li>)}</ul>}>
      <span className="desk-time-cal-mark" tabIndex={0} role="img" aria-label={L(`${dayName(date)}：${titles.join('、')}`,`${dayName(date)}: ${titles.join(', ')}`)}>{num}<i className="desk-time-cal-dot"/></span>
    </Tooltip>;
  };
  return <>
    <Title id={hid} text={block.title}/>
    <p className="desk-time-cal-month">{L(<>{block.month.slice(0,4)}年{+block.month.slice(5)}月</>,<>{new Date(+block.month.slice(0,4),+block.month.slice(5,7)-1,1).toLocaleDateString('en-US',{month:'long',year:'numeric'})}</>)}</p>
    <div className="desk-time-cal">
      {/* Static days are plain divs; every focus stop is the marked day itself, so the month's own tab stop is switched off. */}
      <Month month={`${block.month}-01`} static __preventFocus hideOutsideDates firstDayOfWeek={1} weekendDays={[]} locale={L('zh-cn','en')} size="md" renderDay={renderDay}
        getDayProps={()=>({'aria-label':undefined})}/>
    </div>
  </>;
}
