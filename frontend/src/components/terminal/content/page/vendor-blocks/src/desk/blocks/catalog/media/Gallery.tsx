import {useState,type KeyboardEvent} from 'react';
import {ActionIcon,Modal} from '@mantine/core';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import type {BlockProps} from '../../types';
import {Caption,Pic} from './Picture';
import {L} from '../../../../../shared/i18n';

/** A grid of pictures; one opens large in a lightbox, where ← and → (or the buttons) go round the set. */
export function GalleryBlock({block}:BlockProps<'gallery'>){
 const items=block.items,n=items.length,[open,setOpen]=useState<number|null>(null);
 const move=(by:number)=>setOpen(i=>i===null?i:(i+by+n)%n),at=open===null?null:items[open];
 const key=(event:KeyboardEvent)=>{
  const by=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;if(!by||n<2)return;
  // The lightbox sits in the block's React tree (portalled), so its keys would otherwise reach the block's shell too.
  event.preventDefault();event.stopPropagation();move(by);
 };
 return <>
  <ul className="desk-gallery">{items.map((p,i)=><li key={i}>
   <button type="button" className="desk-gallery-thumb" onClick={()=>setOpen(i)} aria-label={p.alt?L(`放大看：${p.alt}`,`Enlarge: ${p.alt}`):L(`放大看第 ${i+1} 张`,`Enlarge image ${i+1}`)}><Pic src={p.url} alt={p.alt}/></button>
   {p.caption&&<span className="desk-media-caption">{p.caption}</span>}
  </li>)}</ul>
  <Modal opened={at!==null} onClose={()=>setOpen(null)} onKeyDown={key} title={open===null?'':`${open+1} / ${n}`} size="auto" centered
   classNames={{content:'desk-lightbox',body:'desk-lightbox-body'}} closeButtonProps={{'aria-label':L('关闭','Close')}}>
   {at&&<figure className="desk-media-figure">
    <Pic className="desk-lightbox-img" src={at.url} alt={at.alt??at.caption} link/>
    <Caption text={at.caption}/>
   </figure>}
   {n>1&&<div className="desk-lightbox-nav">
    <ActionIcon variant="default" size="lg" aria-label={L('上一张','Previous image')} onClick={()=>move(-1)}><ChevronLeft size={18}/></ActionIcon>
    <ActionIcon variant="default" size="lg" aria-label={L('下一张','Next image')} onClick={()=>move(1)}><ChevronRight size={18}/></ActionIcon>
   </div>}
  </Modal>
 </>;
}
