import {z} from 'zod';
import {L} from '../i18n.ts';
import {LIST,TONES,block,day,entry,instant,list,num,opt,or,stext,str,text,unit} from './fields.ts';

const EVENTS=100,ZONES=12;
const month=z.string().trim().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/);

export const TIME=[
  entry({type:'timeline',category:'time',get label(){return L('时间线','Timeline')},describe:'Events in order, each with when (at), title, text and tone.',
    schema:block('timeline',{title:opt(str),items:list(z.object({at:stext,title:text,text:opt(str),tone:opt(z.enum(TONES))}),LIST)}),
    example:{type:'timeline',items:[{at:'Oct 2',title:'Kickoff'},{at:'Oct 9',title:'Beta',tone:'success'}]}}),
  entry({type:'milestones',category:'time',get label(){return L('里程碑','Milestones')},describe:'Milestones with a date and done.',
    schema:block('milestones',{title:opt(str),items:list(z.object({label:text,date:stext,done:or(z.boolean(),false)}),LIST)}),
    example:{type:'milestones',items:[{label:'Spec',date:'2026-10-01',done:true},{label:'Launch',date:'2026-11-01',done:false}]}}),
  // Past the last step means all of them are done.
  entry({type:'stepper',category:'time',get label(){return L('步骤条','Steps')},describe:'Steps; current is the 0-based step under way, the step count once all are done.',
    schema:block('stepper',{title:opt(str),steps:list(z.object({label:stext,text:opt(str)}),LIST),current:or(num,0)})
      .transform(b=>({...b,current:Math.min(b.steps.length,Math.max(0,Math.round(b.current)))})),
    example:{type:'stepper',steps:[{label:'Draft'},{label:'Review'},{label:'Ship'}],current:1}}),
  entry({type:'agenda',category:'time',get label(){return L('日程','Agenda')},describe:'One day\'s schedule: time, title, note.',
    schema:block('agenda',{title:opt(str),date:opt(stext),items:list(z.object({time:stext,title:text,note:opt(str)}),LIST)}),
    example:{type:'agenda',date:'2026-10-20',items:[{time:'09:00',title:'Standup'}]}}),
  // The month is what is drawn, so an event outside it would never show.
  entry({type:'calendar',category:'time',get label(){return L('月历','Month calendar')},describe:'One month (YYYY-MM) with events on its days (YYYY-MM-DD).',
    schema:block('calendar',{title:opt(str),month,events:or(list(z.object({date:day,title:stext}),EVENTS,0),[] as {date:string;title:string}[])})
      .transform(b=>({...b,events:b.events.filter(e=>e.date.startsWith(`${b.month}-`))})),
    example:{type:'calendar',month:'2026-10',events:[{date:'2026-10-20',title:'Flight'}]}}),
  entry({type:'gantt',category:'time',get label(){return L('甘特图','Gantt chart')},describe:'Bars from start to end (YYYY-MM-DD), with group and done 0-1.',
    schema:block('gantt',{title:opt(str),items:list(z.object({label:stext,start:instant,end:instant,group:opt(stext),done:opt(unit)}).refine(i=>Date.parse(i.end)>=Date.parse(i.start)),LIST)}),
    example:{type:'gantt',items:[{label:'Build',start:'2026-10-01',end:'2026-10-14',done:0.5}]}}),
  entry({type:'countdown',category:'time',get label(){return L('倒计时','Countdown')},describe:'Time left until "to", an ISO date or date-time.',
    schema:block('countdown',{title:text,to:instant}),example:{type:'countdown',title:'Launch',to:'2026-11-01T09:00:00Z'}}),
  // A zone name is checked where it is drawn, which says so instead of failing the block.
  entry({type:'clocks',category:'time',get label(){return L('多时区时钟','World clocks')},describe:'Clocks for IANA time zones, computed on the device.',
    schema:block('clocks',{zones:list(z.object({label:stext,tz:text}),ZONES)}),
    example:{type:'clocks',zones:[{label:'Tokyo',tz:'Asia/Tokyo'},{label:'NYC',tz:'America/New_York'}]}}),
] as const;
