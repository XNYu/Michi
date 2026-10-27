import {useState,type HTMLAttributeReferrerPolicy} from 'react';
import type {BlockProps} from '../../types';
import {Caption,OUT,domainOf} from './Picture';
import {L} from '../../../../../shared/i18n';

const YT_ID=/^[\w-]{11}$/,VIMEO_ID=/^\d+$/,VIMEO_HASH=/^[\da-f]+$/i;
const YOUTUBE=new Set(['youtube.com','youtube-nocookie.com']),VIMEO=new Set(['vimeo.com','player.vimeo.com']);
const parse=(raw:string)=>{try{const u=new URL(raw);return u.protocol==='https:'?u:null;}catch{return null;}};
const hostOf=(u:URL)=>u.hostname.toLowerCase().replace(/^(?:www|m)\./,'');
/** A page on YouTube or Vimeo: it plays in their frame or not at all, never in a <video>. */
const videoSite=(raw:string)=>{const u=parse(raw),h=u&&hostOf(u);return !!h&&(YOUTUBE.has(h)||h==='youtu.be'||VIMEO.has(h));};
/** `referrer`: what a page loads sends none, but YouTube's player refuses to play without one (its error 153), so a YouTube frame alone
 * is told Desk's origin (http://127.0.0.1:port, never the path) and nothing more. */
type Frame={src:string;referrer:HTMLAttributeReferrerPolicy};

/** Where one YouTube or Vimeo video plays in a frame: YouTube through its no-cookie host, Vimeo through its player. Any other address,
 * or a page of theirs that is not one video (a channel, a playlist), has none. */
export function videoFrame(raw:string):Frame|null{
 const u=parse(raw);if(!u)return null;
 const h=hostOf(u),path=u.pathname.split('/').filter(Boolean);
 if(h==='youtu.be'||YOUTUBE.has(h)){
  const id=h==='youtu.be'?(path.length===1?path[0]:null):path.length===1&&path[0]==='watch'?u.searchParams.get('v'):path.length===2&&(path[0]==='shorts'||path[0]==='embed')?path[1]:null;
  return id&&YT_ID.test(id)?{src:`https://www.youtube-nocookie.com/embed/${id}`,referrer:'strict-origin'}:null;
 }
 if(!VIMEO.has(h))return null;
 // vimeo.com/<id>, vimeo.com/<id>/<hash> (an unlisted video) and the player's own address.
 const [id,hash]=h==='player.vimeo.com'?(path[0]==='video'&&path.length===2?[path[1],u.searchParams.get('h')]:[]):path.length<=2?path:[];
 if(!id||!VIMEO_ID.test(id))return null;
 return {src:`https://player.vimeo.com/video/${id}${hash&&VIMEO_HASH.test(hash)?`?h=${hash}`:''}`,referrer:'no-referrer'};
}

/** What a frame of someone else's page may do: run as itself on its own site, take input and open windows, never steer Desk's tab. */
export const FRAME_SANDBOX='allow-scripts allow-same-origin allow-forms allow-popups';
/** allow-same-origin hands a frame its own origin; one whose address could be Desk's would get Desk's, so only another https site is framed.
 * The catalog already lets through https only and Desk is served over http, so this is the check made where the frame is drawn. */
const foreign=(raw:string)=>{const u=parse(raw);return u&&u.origin!==window.location.origin?u.href:null;};
const OpenOut=({url,children}:{url:string;children:string})=><a className="desk-media-out" href={url} {...OUT}>{children}</a>;

export function VideoBlock({block}:BlockProps<'video'>){
 const frame=videoFrame(block.url),[failed,setFailed]=useState(false),name=block.caption||L('视频','Video');
 const src=frame&&foreign(frame.src);
 return <figure className="desk-media-figure">
  {src?<div className="desk-video-frame"><iframe src={src} title={name} sandbox={`${FRAME_SANDBOX} allow-presentation`} referrerPolicy={frame.referrer} loading="lazy"
   allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen/></div>
   :videoSite(block.url)?<OpenOut url={block.url}>{L(`在 ${domainOf(block.url)} 打开这个视频 ↗`,`Open this video on ${domainOf(block.url)} ↗`)}</OpenOut>
   :failed?<OpenOut url={block.url}>{L('视频没能播放，在浏览器打开 ↗','The video couldn’t play. Open it in the browser ↗')}</OpenOut>
   :<video className="desk-video" src={block.url} controls preload="metadata" onError={()=>setFailed(true)}/>}
  <Caption text={block.caption}/>
 </figure>;
}

/** Named by its caption (or as 「音频」) for a screen reader; one that will not play offers its address instead, as video does. */
export function AudioBlock({block}:BlockProps<'audio'>){
 const [failed,setFailed]=useState(false);
 return <figure className="desk-media-figure">
  {failed?<OpenOut url={block.url}>{L('音频没能播放，在浏览器打开 ↗','The audio couldn’t play. Open it in the browser ↗')}</OpenOut>
   :<audio className="desk-audio" src={block.url} controls preload="metadata" aria-label={block.caption||L('音频','Audio')} onError={()=>setFailed(true)}/>}
  <Caption text={block.caption}/>
 </figure>;
}

/** Any https page, live in a frame. Some sites refuse to be framed and leave it blank, so the bar above always offers the page itself. */
// Michi: the frame loads only after a click, drops allow-popups, and the bar leads with the real domain (the model's title is secondary).
const EMBED_SANDBOX='allow-scripts allow-same-origin allow-forms';
export function EmbedBlock({block}:BlockProps<'embed'>){
 const domain=domainOf(block.url),name=block.title||domain,src=foreign(block.url),[loaded,setLoaded]=useState(false);
 return <div className="desk-embed">
  <div className="desk-embed-bar"><span className="desk-embed-domain">{domain}</span>{block.title&&<span className="desk-embed-title">{block.title}</span>}<span aria-hidden="true">·</span><OpenOut url={block.url}>{L('在浏览器打开 ↗','Open in the browser ↗')}</OpenOut></div>
  {!src?<p className="desk-quiet">{L('这个网址不能嵌在这里','This address can’t be embedded here')}</p>
   :loaded?<iframe className="desk-embed-frame" src={src} title={name} style={{height:block.height??480}} sandbox={EMBED_SANDBOX} referrerPolicy="no-referrer" loading="lazy"/>
   :<div className="desk-embed-placeholder" style={{height:block.height??480}}><button type="button" onClick={()=>setLoaded(true)}>{L('加载页面','Load page')}</button></div>}
 </div>;
}
