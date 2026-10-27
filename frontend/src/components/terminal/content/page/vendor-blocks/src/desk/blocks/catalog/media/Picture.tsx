// Michi: use the native page image permission and URL policy.
import {useState} from 'react';
import {usePageImage} from '../../../../vendor/michi/components/MarkdownImage';
import './media.css';
import {L} from '../../../../../shared/i18n';

/** An outside link: a new tab that learns nothing about Desk and cannot reach back into it. */
export const OUT={target:'_blank',rel:'noopener noreferrer'} as const;
/** The site an address is on, as people say it. */
export const domainOf=(url:string)=>{try{return new URL(url).hostname.replace(/^www\./,'');}catch{return url;}};

/** A picture loaded as Task 11 loads one: https only, sending no referrer, not before it is near the screen. One that will not load leaves
 * its words; where a link may sit (`link`), they open the picture, so it can still be seen. */
export function Pic({src,alt,className,link=false}:{src:string;alt?:string;className?:string;link?:boolean}){
 const url=usePageImage(src),[failed,setFailed]=useState<string|null>(null);
 if(url&&failed!==url)return <img className={className} src={url} alt={alt??''} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={()=>setFailed(url)}/>;
 const words=alt?.trim()||L('图片没能加载','The image couldn’t load');
 return link&&url?<a className="desk-media-missing" href={url} {...OUT}>{words}</a>:<span className="desk-media-missing">{words}</span>;
}

export const Caption=({text}:{text?:string})=>text?<figcaption className="desk-media-caption">{text}</figcaption>:null;
