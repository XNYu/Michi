import type {BlockProps} from '../../types';
import {dayText} from './format';
import {Title} from './Title';
import './time.css';

/** One day: the time on the left, then the title and, quieter, its note. */
export function AgendaBlock({block,hid}:BlockProps<'agenda'>){
  return <>
    <Title id={hid} text={block.title}/>
    {block.date&&<p className="desk-agenda-date">{dayText(block.date)}</p>}
    <ul className="desk-agenda">
      {block.items.map((it,i)=><li key={i} className="desk-agenda-row">
        <span className="desk-agenda-time">{it.time}</span>
        <span className="desk-agenda-body"><span className="desk-agenda-title">{it.title}</span>{it.note&&<span className="desk-agenda-note">{it.note}</span>}</span>
      </li>)}
    </ul>
  </>;
}
