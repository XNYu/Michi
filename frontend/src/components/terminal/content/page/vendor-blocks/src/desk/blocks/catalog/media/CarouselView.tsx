import {useEffect,useRef,useState} from 'react';
import {Carousel} from '@mantine/carousel';
import {VisuallyHidden} from '@mantine/core';
import type {EmblaCarouselType} from 'embla-carousel';
import type {BlockProps} from '../../types';
import {Caption,Pic} from './Picture';
import {L} from '../../../../../shared/i18n';

/** Mantine writes the slide counter ("Slide 1 of 3") and the dots' tablist name ("Slides") in English, with no prop to change either. So its counter is
 * taken out of the accessibility tree (hidden, not removed: React still owns it) and this one says the same in Chinese; the tablist is renamed.
 * The region, its slides and the controls take their words as props. */
const REGION=L('图片轮播','Image carousel'),DOTS=L('切换图片','Switch image'),count=(at:number,of:number)=>L(`第 ${at+1} 张，共 ${of} 张`,`Image ${at+1} of ${of}`);
const child=(root:HTMLElement,role:string)=>[...root.children].find(el=>el.getAttribute('role')===role);

/** One picture at a time, swiped or stepped through, with a dot per picture. */
export default function CarouselView({block}:BlockProps<'carousel'>){
 const n=block.items.length,many=n>1,root=useRef<HTMLDivElement>(null);
 const [embla,setEmbla]=useState<EmblaCarouselType|null>(null),[at,setAt]=useState(0);
 // embla's own `select`, so a swipe, a control, a dot and the keyboard all announce; the page was drawn on the first picture.
 useEffect(()=>{
  if(!embla)return;
  const sync=()=>setAt(embla.selectedScrollSnap());sync();embla.on('select',sync).on('reInit',sync);
  return()=>{embla.off('select',sync).off('reInit',sync);};
 },[embla]);
 // The dots exist only with more than one picture; run again when that changes.
 useEffect(()=>{
  const el=root.current;if(!el)return;
  const counter=child(el,'status');if(counter){counter.setAttribute('hidden','');counter.setAttribute('aria-hidden','true');}
  child(el,'tablist')?.setAttribute('aria-label',DOTS);
 },[many]);
 return <>
  <Carousel ref={root} className="desk-carousel" withIndicators={many} withControls={many} getEmblaApi={setEmbla} aria-label={REGION} aria-roledescription={L('轮播','carousel')}
   classNames={{indicators:'desk-carousel-dots',indicator:'desk-carousel-dot',control:'desk-carousel-control'}}
   previousControlProps={{'aria-label':L('上一张','Previous image')}} nextControlProps={{'aria-label':L('下一张','Next image')}} getIndicatorProps={i=>({'aria-label':L(`第 ${i+1} 张`,`Image ${i+1}`)})}>
   {block.items.map((p,i)=><Carousel.Slide key={i} aria-roledescription={L('图片','image')} aria-label={count(i,n)}><figure className="desk-media-figure">
    <Pic className="desk-carousel-img" src={p.url} alt={p.caption} link/>
    <Caption text={p.caption}/>
   </figure></Carousel.Slide>)}
  </Carousel>
  {many&&<VisuallyHidden role="status" aria-live="polite" aria-atomic="true">{count(Math.min(at,n-1),n)}</VisuallyHidden>}
 </>;
}
