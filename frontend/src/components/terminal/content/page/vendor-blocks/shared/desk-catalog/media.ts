import {z} from 'zod';
import {L} from '../i18n.ts';
import {LIST,block,entry,height,known,list,opt,optUrl,stext,str,text,url} from './fields.ts';

const LINKS=10;
const picture={url,alt:opt(str),caption:opt(str)};

// Spec 4.1: every address a block loads by itself is https, or the block goes; in a gallery or carousel only that picture goes.
export const MEDIA=[
  entry({type:'image',category:'media',get label(){return L('图片','Image')},describe:'One image.',schema:block('image',picture),example:{type:'image',url:'https://example.com/a.jpg',alt:'Lobby'}}),
  entry({type:'gallery',category:'media',get label(){return L('画廊','Gallery')},describe:'Grid of images that open large.',
    schema:block('gallery',{items:list(z.object(picture),LIST)}),example:{type:'gallery',items:[{url:'https://example.com/a.jpg'},{url:'https://example.com/b.jpg'}]}}),
  entry({type:'before-after',category:'media',get label(){return L('前后对比','Before and after')},describe:'Two images, before and after, compared with a slider.',
    schema:block('before-after',{before:url,after:url,caption:opt(str)}),example:{type:'before-after',before:'https://example.com/old.png',after:'https://example.com/new.png'}}),
  entry({type:'carousel',category:'media',get label(){return L('轮播','Carousel')},describe:'Images one at a time, swiped through.',
    schema:block('carousel',{items:list(z.object({url,caption:opt(str)}),LIST)}),example:{type:'carousel',items:[{url:'https://example.com/a.jpg',caption:'Day 1'}]}}),
  entry({type:'video',category:'media',get label(){return L('视频','Video')},describe:'A video file, or a YouTube or Vimeo page.',
    schema:block('video',{url,caption:opt(str)}),example:{type:'video',url:'https://youtu.be/dQw4w9WgXcQ'}}),
  entry({type:'audio',category:'media',get label(){return L('音频','Audio')},describe:'An audio file.',schema:block('audio',{url,caption:opt(str)}),example:{type:'audio',url:'https://example.com/a.mp3'}}),
  entry({type:'embed',category:'media',get label(){return L('嵌入网页','Embedded page')},describe:'A live web page in a frame, height 120-1200.',
    schema:block('embed',{url,title:opt(str),height:opt(height(120,1200))}),example:{type:'embed',url:'https://example.com',height:480}}),
  // Desk never fetches the page: what the card says is what the agent wrote.
  entry({type:'link',category:'media',get label(){return L('链接卡片','Link card')},describe:'Link card; you write its title, description, image and site, nothing is fetched.',
    schema:block('link',{url,title:text,description:opt(str),image:optUrl,site:opt(str)}),example:{type:'link',url:'https://example.com/post',title:'Release notes',site:'example.com'}}),
  entry({type:'file',category:'media',get label(){return L('文件卡片','File card')},describe:'A file by path with a note; the path is shown as text, not a link.',
    schema:block('file',{path:text,title:opt(str),note:opt(str)}),example:{type:'file',path:'docs/plan.md',note:'Latest plan'}}),
  entry({type:'thread-card',category:'media',get label(){return L('对话卡片','Conversation card')},describe:'One conversation card, by an id from THREADS.',
    schema:block('thread-card',{threadId:text.refine(known)}),example:{type:'thread-card',threadId:'t1'}}),
  entry({type:'threads',category:'media',get label(){return L('各条线','Threads')},describe:'Cards for several conversations, by ids from THREADS. The title is optional: a tab or toggle around it can name the group instead.',
    schema:block('threads',{title:opt(text),threadIds:list(text.refine(known),LIST,1,true)}),example:{type:'threads',title:'In progress',threadIds:['t1','t2']}}),
  entry({type:'person',category:'media',get label(){return L('人物卡片','Person card')},describe:'A person: name, role, avatar image, note, links.',
    schema:block('person',{name:text,role:opt(str),avatar:optUrl,note:opt(str),links:opt(list(z.object({label:stext,url}),LINKS,0).transform(a=>a.length?a:undefined))}),
    example:{type:'person',name:'Ann Lee',role:'Designer',links:[{label:'Site',url:'https://example.com'}]}}),
  entry({type:'place',category:'media',get label(){return L('地点卡片','Place card')},describe:'A place: name, address, note; opens in a maps app, no map is drawn.',
    schema:block('place',{name:text,address:opt(str),note:opt(str),url:optUrl}),example:{type:'place',name:'Kyoto Station',address:'Kyoto, Japan'}}),
] as const;
