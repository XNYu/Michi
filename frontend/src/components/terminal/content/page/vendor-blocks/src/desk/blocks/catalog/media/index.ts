import {GalleryBlock} from './Gallery';
import {CarouselBlock} from './CarouselBlock';
import {BeforeAfterBlock,ImageBlock} from './images';
import {AudioBlock,EmbedBlock,VideoBlock} from './players';
import {FileBlock,LinkBlock,PersonBlock,PlaceBlock} from './cards';

/** Task 27: the media and link blocks (spec 4.1); `threads` keeps its older drawing in ThreadsBlock. */
// Michi: no thread-card here; Michi draws thread cards itself.
export const MEDIA_RENDERERS={image:ImageBlock,gallery:GalleryBlock,'before-after':BeforeAfterBlock,carousel:CarouselBlock,video:VideoBlock,audio:AudioBlock,
 embed:EmbedBlock,link:LinkBlock,file:FileBlock,person:PersonBlock,place:PlaceBlock};
