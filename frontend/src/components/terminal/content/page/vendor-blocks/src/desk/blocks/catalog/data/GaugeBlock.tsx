import {SemiCircleProgress} from '@mantine/core';
import type {BlockProps} from '../../types';
import {fmt} from './format';
import {L} from '../../../../../shared/i18n';

const SIZE=200;
/** A value on a dial from min to max; past either end it stays on the dial, and the figure in the middle still says the real number. */
export function GaugeBlock({block:{title,value,min,max,unit},hid}:BlockProps<'gauge'>){
 const at=Math.min(max,Math.max(min,value));
 return <>
  <h2 id={hid} className="desk-block-title">{title}</h2>
  <div className="desk-gauge" role="meter" aria-labelledby={hid} aria-valuemin={min} aria-valuemax={max} aria-valuenow={at} aria-valuetext={L(`${fmt(value)}${unit??''}，范围 ${fmt(min)} 到 ${fmt(max)}`,`${fmt(value)}${unit??''}, range ${fmt(min)} to ${fmt(max)}`)}>
   <SemiCircleProgress value={(at-min)/(max-min)*100} size={SIZE} thickness={16} filledSegmentColor="var(--accent)" emptySegmentColor="var(--subtle)" labelPosition="center"
    label={<span className="desk-gauge-value">{fmt(value)}{unit&&<small>{unit}</small>}</span>}/>
   <div className="desk-gauge-range" style={{width:SIZE}} aria-hidden="true"><span>{fmt(min)}</span><span>{fmt(max)}</span></div>
  </div>
 </>;
}
