import {useState,type CSSProperties} from 'react';
import type {BlockProps} from '../../types';
import {Caption,Pic} from './Picture';
import {L} from '../../../../../shared/i18n';

export const ImageBlock=({block}:BlockProps<'image'>)=><figure className="desk-media-figure">
 <Pic className="desk-media-img" src={block.url} alt={block.alt??block.caption} link/>
 <Caption text={block.caption}/>
</figure>;

/** Before underneath, after over it from the divider to the right edge; the range input is laid over both, so dragging anywhere on the
 * pictures moves the divider and the keyboard moves it too. It covers the pictures, so one that will not load leaves words, not a link. */
export function BeforeAfterBlock({block}:BlockProps<'before-after'>){
 const [at,setAt]=useState(50);
 return <figure className="desk-media-figure">
  <div className="desk-compare-pics" style={{'--at':`${at}%`} as CSSProperties}>
   <Pic className="desk-media-img" src={block.before} alt={L('之前的图片','Image before')}/>
   <div className="desk-compare-after"><Pic className="desk-media-img" src={block.after} alt={L('之后的图片','Image after')}/></div>
   <span className="desk-compare-line" aria-hidden="true"/>
   <span className="desk-compare-tag" data-side="before" aria-hidden="true">{L('之前','Before')}</span><span className="desk-compare-tag" data-side="after" aria-hidden="true">{L('之后','After')}</span>
   <input className="desk-compare-range" type="range" min={0} max={100} value={at} onChange={event=>setAt(Number(event.target.value))}
    aria-label={L('对比之前和之后','Compare before and after')} aria-valuetext={L(`之前 ${at}%，之后 ${100-at}%`,`Before ${at}%, after ${100-at}%`)}/>
  </div>
  <Caption text={block.caption}/>
 </figure>;
}
