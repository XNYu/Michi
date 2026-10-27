import {Suspense,lazy} from 'react';
import type {BlockProps} from '../../types';
import {Caption,Pic} from './Picture';

// The carousel (embla) comes with the first one drawn; until then its first picture stands where it will be.
const CarouselView=lazy(()=>import('./CarouselView'));
export function CarouselBlock(p:BlockProps<'carousel'>){
 const first=p.block.items[0];
 return <Suspense fallback={first&&<figure className="desk-media-figure"><Pic className="desk-carousel-img" src={first.url} alt={first.caption} link/><Caption text={first.caption}/></figure>}>
  <CarouselView {...p}/>
 </Suspense>;
}
