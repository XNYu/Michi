import {useMemo} from 'react';
import type {BlockProps} from '../../types';
import {faceOf} from './format';
import {useNow} from './useNow';
import './time.css';
import {L} from '../../../../../shared/i18n';

/** Each zone read off this device's clock. A name the device does not know says so on its own card and leaves the others running. */
export function ClocksBlock({block}:BlockProps<'clocks'>){
  const now=useNow(),faces=useMemo(()=>block.zones.map(z=>({...z,face:faceOf(z.tz)})),[block.zones]);
  return <ul className="desk-clocks">
    {faces.map((z,i)=>{
      const face=z.face?.(now);
      return <li key={i} className="desk-clock" data-invalid={face?undefined:true}>
        <span className="desk-clock-label">{z.label}</span>
        {face?<>
          <span className="desk-clock-time">{face.time}</span>
          <span className="desk-clock-date">{face.date}{face.offset&&` · ${face.offset}`}</span>
        </>:<>
          <span className="desk-clock-bad">{L('时区无效','Invalid time zone')}</span>
          <span className="desk-clock-date">{z.tz}</span>
        </>}
      </li>;
    })}
  </ul>;
}
