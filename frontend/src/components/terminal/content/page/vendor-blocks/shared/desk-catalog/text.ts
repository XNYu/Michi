import {z} from 'zod';
import {L} from '../i18n.ts';
import type {PageBlockWithSources} from '../desk-blocks.ts';
import {LIST,SHORT,SLOT,TONES,block,clip,entry,kids,list,long,longText,opt,or,stext,str,text,type PageBlockMeta} from './fields.ts';

const tone=opt(z.enum(TONES)),lang=opt(z.string().transform(s=>clip(s.trim(),40)).refine(Boolean));
type Kids=PageBlockWithSources[];
// A container holds blocks of the union it is part of, which inference cannot follow round, so these three are written out.
export interface ToggleBlock extends PageBlockMeta{id:string;type:'toggle';title:string;blocks:Kids}
export interface ColumnsBlock extends PageBlockMeta{id:string;type:'columns';columns:Kids[]}
export interface TabsBlock extends PageBlockMeta{id:string;type:'tabs';tabs:{label:string;blocks:Kids}[]}
type Schema<T>=z.ZodType<T,z.ZodTypeDef,unknown>;
/** An empty column or tab is part of the layout and stays; a container with nothing in any slot shows nothing, so it goes, unless a
 * person emptied it (it carries their edit mark), when it is still somewhere to drop blocks into. */
const some=(slots:Kids[],b:{edit?:unknown})=>!!b.edit||slots.some(s=>s.length>0);
const toggle:Schema<ToggleBlock>=block('toggle',{title:text,blocks:kids(SLOT)}).refine(b=>some([b.blocks],b));
const columns:Schema<ColumnsBlock>=block('columns',{columns:list(kids(SLOT),4,2)}).refine(b=>some(b.columns,b));
const tabs:Schema<TabsBlock>=block('tabs',{tabs:list(z.object({label:stext,blocks:kids(SLOT)}),6,2)}).refine(b=>some(b.tabs.map(t=>t.blocks),b));

export const TEXT=[
  entry({type:'heading',category:'text',get label(){return L('标题','Heading')},describe:'Section heading, level 1-3 (default 2).',
    schema:block('heading',{level:or(z.union([z.literal(1),z.literal(2),z.literal(3)]),2 as const),text:text.transform(s=>clip(s,SHORT))}),
    example:{type:'heading',level:2,text:'Next steps'}}),
  entry({type:'markdown',category:'text',get label(){return L('段落','Paragraph')},describe:'Prose in Markdown: paragraphs, lists, links, bold.',
    schema:block('markdown',{text}),example:{type:'markdown',text:'Booked **2 of 3** hotels.'}}),
  entry({type:'callout',category:'text',get label(){return L('提示框','Callout')},describe:'Boxed note; tone info, warn, success or danger.',
    schema:block('callout',{title:opt(str),text,tone}),example:{type:'callout',tone:'warn',title:'Blocked',text:'Visa not issued yet.'}}),
  entry({type:'quote',category:'text',get label(){return L('引用','Quote')},describe:'A quotation, cite optional.',
    schema:block('quote',{text,cite:opt(str)}),example:{type:'quote',text:'Ship the smallest thing.',cite:'Ann'}}),
  entry({type:'toggle',category:'text',get label(){return L('折叠','Toggle')},describe:'Collapsed section; its blocks show when opened.',container:true,
    schema:toggle,example:{type:'toggle',title:'Details',blocks:[{type:'markdown',text:'Notes.'}]}}),
  entry({type:'columns',category:'text',get label(){return L('分栏','Columns')},describe:'2-4 side-by-side columns, each a list of blocks.',container:true,
    schema:columns,
    example:{type:'columns',columns:[[{type:'markdown',text:'Left'}],[{type:'markdown',text:'Right'}]]}}),
  entry({type:'tabs',category:'text',get label(){return L('标签页','Tabs')},describe:'2-6 tabs, each a label and its blocks.',container:true,
    schema:tabs,
    example:{type:'tabs',tabs:[{label:'Plan',blocks:[{type:'markdown',text:'A'}]},{label:'Actual',blocks:[{type:'markdown',text:'B'}]}]}}),
  entry({type:'divider',category:'text',get label(){return L('分隔线','Divider')},describe:'A horizontal rule.',schema:block('divider',{}),example:{type:'divider'}}),
  entry({type:'toc',category:'text',get label(){return L('目录','Contents')},describe:'Contents: links to the headings on the page.',schema:block('toc',{}),example:{type:'toc'}}),
  entry({type:'code',category:'text',get label(){return L('代码','Code')},describe:'Highlighted code; lang like ts, py, sh.',
    schema:block('code',{lang,title:opt(str),code:longText}),example:{type:'code',lang:'ts',code:'const x = 1;'}}),
  entry({type:'diff',category:'text',get label(){return L('代码对比','Code diff')},describe:'Line diff of before against after.',
    schema:block('diff',{title:opt(str),lang,before:long,after:long}).refine(b=>b.before.trim()!==''||b.after.trim()!==''),
    example:{type:'diff',before:'a = 1',after:'a = 2'}}),
  entry({type:'math',category:'text',get label(){return L('公式','Formula')},describe:'A KaTeX formula; display:true sets it on its own line.',
    schema:block('math',{tex:text,display:opt(z.boolean())}),example:{type:'math',tex:'E = mc^2',display:true}}),
  entry({type:'mermaid',category:'text',get label(){return L('流程图','Flowchart')},describe:'Mermaid source for a flowchart or sequence diagram.',
    schema:block('mermaid',{code:longText}),example:{type:'mermaid',code:'graph LR; A-->B'}}),
  entry({type:'keyvalue',category:'text',get label(){return L('键值表','Key-value list')},describe:'Key and value pairs.',
    schema:block('keyvalue',{title:opt(str),items:list(z.object({key:stext,value:stext}),LIST)}),example:{type:'keyvalue',items:[{key:'Owner',value:'Ann'}]}}),
  entry({type:'tags',category:'text',get label(){return L('标签组','Tags')},describe:'Inline tags; tone as for callout.',
    schema:block('tags',{items:list(z.object({label:stext,tone}),LIST)}),example:{type:'tags',items:[{label:'urgent',tone:'danger'},{label:'docs'}]}}),
] as const;
