import {useMemo,type ReactNode,type Ref} from 'react';
import {isDateValue,type CellValue,type DateValue} from '../../../../shared/desk-db';
import {L} from '../../../../shared/i18n';
import {parseDay} from '../db-ui';
import './bars.css';

/** Day arithmetic and the bars of a timeline (spec §3.3), apart from any database: the timeline view draws these and drags them, the gantt
 * component (Task 26) draws them read-only. Days are whole numbers of local days, so a DST hour never shifts a bar. */
export type Zoom='day'|'week'|'month';
export type Span={start:number;end:number};
export type Edge='start'|'end';
/** Pixels a day takes: wide enough for its number, a week for 「10月13日」, a month for 「10月」. */
export const PX:Record<Zoom,number>={day:32,week:14,month:4};
export const LABEL_WIDTH=200;
const MS=86_400_000,DAY=/^\d{4}-\d{2}-\d{2}$/;
const pad=(n:number)=>String(n).padStart(2,'0');
const utc=(y:number,m:number,d:number)=>Math.round(Date.UTC(y,m,d)/MS);
export const dayOfDate=(d:Date)=>utc(d.getFullYear(),d.getMonth(),d.getDate());
export const dayNum=(s:string)=>{const d=parseDay(s);return d?dayOfDate(d):null;};
export const ymd=(n:number)=>{const d=new Date(n*MS);return {y:d.getUTCFullYear(),m:d.getUTCMonth(),d:d.getUTCDate()};};
export const dayStr=(n:number)=>{const {y,m,d}=ymd(n);return `${y}-${pad(m+1)}-${pad(d)}`;};
export const todayNum=()=>dayOfDate(new Date());
/** 0 is Monday: weeks start on Monday. */
export const weekday=(n:number)=>(new Date(n*MS).getUTCDay()+6)%7;
export const weekStart=(n:number)=>n-weekday(n);
export const monthStart=(n:number)=>{const {y,m}=ymd(n);return utc(y,m,1);};
/** The same day k months on, or that month's last day when it is shorter. */
export function addMonths(n:number,k:number){const {y,m,d}=ymd(n);return utc(y,m+k,Math.min(d,new Date(Date.UTC(y,m+k+1,0)).getUTCDate()));}
/** How many days n steps of a zoom are from `from`: a month step is a calendar month, not 30 days. */
export const stepDays=(from:number,n:number,zoom:Zoom)=>zoom==='month'?addMonths(from,n)-from:zoom==='week'?n*7:n;
/** English month names, short. */
export const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export const monthLabel=(n:number)=>{const {y,m}=ymd(n);return L(`${y}年${m+1}月`,`${MONTHS[m]} ${y}`);};

/** A cell as a date: a DateValue, or a bare day an older table left there. Anything unreadable is no date. */
export function dateOf(v:CellValue|undefined):DateValue|null{
  const date=isDateValue(v)?v:typeof v==='string'&&v.trim()?{start:v}:null;
  return date&&dayNum(date.start)!==null?date:null;
}
/** The days a value covers, both ends in; an end that is unreadable or before the start counts as the start's day. */
export function spanOf(v:DateValue|null|undefined):Span|null{
  const start=v?dayNum(v.start):null;if(start===null)return null;
  const end=v?.end?dayNum(v.end):null;return {start,end:end!==null&&end>start?end:start};
}
const timeOf=(s:string)=>parseDay(s)?.getTime()??NaN;
/** A plain day stays a plain day; a time keeps its local time of day, across a DST change too. */
export function shiftDay(s:string,days:number):string{
  if(!days)return s;
  if(DAY.test(s)){const n=dayNum(s);return n===null?s:dayStr(n+days);}
  const t=Date.parse(s);if(Number.isNaN(t))return s;
  const d=new Date(t);d.setDate(d.getDate()+days);return d.toISOString();
}
const tidy=(start:string,end:string|undefined):DateValue=>end&&end!==start?{start,end}:{start};
/** The whole value n steps on; its length in days stays. */
export function moveRange(v:DateValue,n:number,zoom:Zoom='day'):DateValue{
  const span=spanOf(v);if(!span||!n)return v;
  const days=stepDays(span.start,n,zoom);return tidy(shiftDay(v.start,days),v.end&&shiftDay(v.end,days));
}
/** One end n steps on and the other where it was. The ends never cross, so a range is at least its one day; one that ends where it starts
 * is a single day again. */
export function moveEdge(v:DateValue,edge:Edge,n:number,zoom:Zoom='day'):DateValue{
  const span=spanOf(v);if(!span||!n)return v;
  const end=v.end&&dayNum(v.end)===span.end?v.end:v.start;
  if(edge==='start'){
    const start=shiftDay(v.start,Math.min(stepDays(span.start,n,zoom),span.end-span.start));
    return tidy(timeOf(start)>timeOf(end)?end:start,end);
  }
  const next=shiftDay(end,Math.max(stepDays(span.end,n,zoom),span.start-span.end));
  return tidy(v.start,timeOf(next)<timeOf(v.start)?v.start:next);
}

/** What the axis covers: every bar and today, at least a week back and a month on, widened to whole weeks or months. */
export function rangeOf(spans:Span[],zoom:Zoom,today=todayNum()):Span{
  let start=today-7,end=today+30;
  for(const s of spans){if(s.start<start)start=s.start;if(s.end>end)end=s.end;}
  if(zoom==='week')return {start:weekStart(start),end:weekStart(end)+6};
  if(zoom==='month')return {start:monthStart(start),end:addMonths(monthStart(end),1)-1};
  return {start,end};
}
export type Tick={day:number;left:number;width:number;label:string};
const yearStart=(n:number)=>utc(ymd(n).y,0,1);
function ticks(range:Span,px:number,first:number,next:(n:number)=>number,label:(n:number,i:number)=>string):Tick[]{
  const out:Tick[]=[];
  for(let n=first,i=0;n<=range.end;n=next(n),i++){const from=Math.max(n,range.start),to=Math.min(next(n)-1,range.end);
    out.push({day:n,left:(from-range.start)*px,width:(to-from+1)*px,label:label(n,i)});}
  return out;
}
/** The axis in two rows: months over days, months over weeks (from Monday), years over months. A month says its year when it is the first
 * on the axis or a January. */
export function scaleOf(range:Span,zoom:Zoom):{major:Tick[];minor:Tick[]}{
  const px=PX[zoom],month=(n:number,i:number)=>{const {y,m}=ymd(n);return i===0||m===0?L(`${y}年${m+1}月`,`${MONTHS[m]} ${y}`):L(`${m+1}月`,MONTHS[m]);};
  const months=(label:(n:number,i:number)=>string)=>ticks(range,px,monthStart(range.start),n=>addMonths(n,1),label);
  if(zoom==='month')return {major:ticks(range,px,yearStart(range.start),n=>utc(ymd(n).y+1,0,1),n=>L(`${ymd(n).y}年`,String(ymd(n).y))),minor:months(n=>L(`${ymd(n).m+1}月`,MONTHS[ymd(n).m]))};
  if(zoom==='week')return {major:months(month),minor:ticks(range,px,weekStart(range.start),n=>n+7,n=>{const {m,d}=ymd(n);return L(`${m+1}月${d}日`,`${MONTHS[m]} ${d}`);})};
  return {major:months(month),minor:ticks(range,px,range.start,n=>n+1,n=>String(ymd(n).d))};
}
export type Box={left:number;width:number};
export type BarBoxes={actual:Box|null;plan:Box|null;overrun:Box|null};
const box=(s:Span,range:Span,px:number):Box=>({left:(s.start-range.start)*px,width:(s.end-s.start+1)*px});
/** Where a row's bars sit on the axis: the actual, the plan under it, and the part of the actual that ends after the plan does. */
export function barsOf(actual:Span|null,plan:Span|null,range:Span,px:number):BarBoxes{
  const over=actual&&plan&&actual.end>plan.end?{start:Math.max(actual.start,plan.end+1),end:actual.end}:null;
  return {actual:actual&&box(actual,range,px),plan:plan&&box(plan,range,px),overrun:over&&box(over,range,px)};
}

/** A line of the chart: a group's heading, or a row with its actual and planned days. `id` is the row's, for the page to find it by. */
export type Lane={key:string;label:ReactNode;group?:boolean;id?:string;actual?:Span|null;plan?:Span|null;title?:string;
  /** How much of the actual bar is done, 0..1: drawn as a fill inside it (the gantt component); the timeline view leaves it out. */done?:number};
export type BarsProps={lanes:Lane[];zoom:Zoom;range:Span;today?:number;label?:string;withPlan?:boolean;
  /** Draws a row's bars; read-only bars when absent. */bar?:(lane:Lane,boxes:BarBoxes)=>ReactNode;scroller?:Ref<HTMLDivElement>};
/** The chart: names down the left, the axis along the top, a bar per row and a line for today. Scrolls both ways inside itself. */
export function Bars({lanes,zoom,range,today=todayNum(),label=L('时间线','Timeline'),withPlan,bar=(lane,boxes)=><StaticBar boxes={boxes} title={lane.title} done={lane.done}/>,scroller}:BarsProps){
  const px=PX[zoom],width=(range.end-range.start+1)*px;
  const scale=useMemo(()=>scaleOf({start:range.start,end:range.end},zoom),[range.start,range.end,zoom]);
  const now=today>=range.start&&today<=range.end?(today-range.start)*px+px/2:null;
  return <div ref={scroller} className="desk-bars" data-zoom={zoom} data-plan={withPlan||undefined} role="group" aria-label={label}>
    <div className="desk-bars-inner" style={{width:LABEL_WIDTH+width}}>
      <div className="desk-bars-head" aria-hidden="true">
        <div className="desk-bars-corner"/>
        <div className="desk-bars-scale" style={{width}}>
          {[scale.major,scale.minor].map((row,i)=><div key={i} className="desk-bars-ticks" data-row={i?'minor':'major'}>
            {row.map(t=><span key={t.day} className="desk-bars-tick" data-weekend={zoom==='day'&&i===1&&weekday(t.day)>4||undefined} style={{left:t.left,width:t.width}}>{t.label}</span>)}
          </div>)}
        </div>
      </div>
      <div className="desk-bars-body">
        <div className="desk-bars-grid" aria-hidden="true" style={{left:LABEL_WIDTH,width}}>
          {scale.minor.map(t=><span key={t.day} style={{left:t.left}}/>)}
          {now!==null&&<i className="desk-bars-today" style={{left:now}}/>}
        </div>
        {lanes.map(l=><div key={l.key} className={l.group?'desk-bars-group':'desk-bars-row'} data-row-id={l.group?undefined:l.id}>
          <div className="desk-bars-label">{l.label}</div>
          <div className="desk-bars-lane" style={{width}}>{l.group?null:bar(l,barsOf(l.actual??null,l.plan??null,range,px))}</div>
        </div>)}
      </div>
    </div>
  </div>;
}

/** A row's bars, not to be dragged. The overrun is drawn inside the actual bar, so it goes wherever the bar goes. With `done` the bar is pale and
 * that share of it filled in, green once it is all done. */
export function StaticBar({boxes:{actual,plan,overrun},title,done,children}:{boxes:BarBoxes;title?:string;done?:number;children?:ReactNode}){
  return <>
    {plan&&<span className="desk-bar-plan" style={{left:plan.left,width:plan.width}}/>}
    {actual&&<span className="desk-bar" title={title} data-done={done===undefined?undefined:done>=1?'all':'part'} style={{left:actual.left,width:actual.width}}>
      {done!==undefined&&done>0&&<span className="desk-bar-done" style={{width:`${done*100}%`}}/>}
      {overrun&&<Overrun actual={actual} overrun={overrun}/>}{children}
    </span>}
  </>;
}
export const Overrun=({actual,overrun}:{actual:Box;overrun:Box})=><span className="desk-bar-over" style={{left:overrun.left-actual.left,width:overrun.width}}/>;
