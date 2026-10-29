// Michi: Find the native page scope, not a Desk page.
import {useContext,useMemo,type MouseEvent} from 'react';
import {flashBlock,whenRevealed} from '../../../peek/use-peek';
import {PageBlocksContext,outline} from './outline';
import './text.css';
import {L} from '../../../../../shared/i18n';

/** The page's headings, indented by level; one click opens whatever toggle or tab holds it, scrolls there and lights it up. */
export function TocBlock(){
 const blocks=useContext(PageBlocksContext),heads=useMemo(()=>blocks?outline(blocks):[],[blocks]);
 if(!heads.length)return <p className="desk-quiet">{L('这一页还没有标题','This page has no headings yet')}</p>;
 const low=Math.min(...heads.map(h=>h.level));
 const go=(event:MouseEvent<HTMLButtonElement>,id:string)=>{
  whenRevealed(event.currentTarget.closest('[data-native-page]')??event.currentTarget.closest('main')??event.currentTarget.closest('.michi-page')??document,id,el=>{flashBlock(el);el.focus({preventScroll:true});});
 };
 return <nav className="desk-toc" aria-label={L('目录','Contents')}><ol>
  {heads.map((h,i)=><li key={`${h.id}/${i}`} style={{paddingLeft:(h.level-low)*16}}><button type="button" onClick={event=>go(event,h.id)}>{h.text}</button></li>)}
 </ol></nav>;
}
