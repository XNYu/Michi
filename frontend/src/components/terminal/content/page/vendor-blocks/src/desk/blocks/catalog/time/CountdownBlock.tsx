import type {BlockProps} from '../../types';
import {instantOf,leftText,whenText} from './format';
import {useNow} from './useNow';
import './time.css';
import {L} from '../../../../../shared/i18n';

/** The title is what is counted down to; the time left is updated once a minute, the target below it so the number can be checked. */
export function CountdownBlock({block,hid}:BlockProps<'countdown'>){
  const now=useNow(),left=instantOf(block.to)-now;
  return <>
    <h2 id={hid} className="desk-block-title">{block.title}</h2>
    <p className="desk-countdown" role="timer" data-over={left<=0||undefined}>{Number.isNaN(left)?block.to:leftText(left)}</p>
    <p className="desk-countdown-to">{L('目标时间 ','Until ')}{whenText(block.to)}</p>
  </>;
}
