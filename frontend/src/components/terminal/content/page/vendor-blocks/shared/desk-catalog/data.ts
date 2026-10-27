import {z} from 'zod';
import {L} from '../i18n.ts';
import {LIST,arr,between,block,cell,entry,list,num,opt,or,scalar,stext,str,text,unit} from './fields.ts';

const COLS=20,ROWS=200,POINTS=100;
const many=or(list(text,LIST,0),[] as string[]);

export const DATA=[
  entry({type:'metrics',category:'data',get label(){return L('指标卡','Metrics')},describe:'A row of labelled figures; tone "warn" flags one.',
    schema:block('metrics',{items:list(z.object({label:text,value:stext,hint:opt(str),tone:opt(z.literal('warn'))}),LIST)}),
    example:{type:'metrics',items:[{label:'Spent',value:'12 days',hint:'of 30'},{label:'Blockers',value:'2',tone:'warn'}]}}),
  entry({type:'stat',category:'data',get label(){return L('大数字','Big number')},describe:'One big figure; delta with deltaTone up, down or flat; spark is a trend of numbers.',
    schema:block('stat',{label:text,value:stext,delta:opt(stext),deltaTone:opt(z.enum(['up','down','flat'])),spark:opt(list(num,POINTS,2))}),
    example:{type:'stat',label:'Weekly users',value:'1,240',delta:'+12%',deltaTone:'up',spark:[3,5,4,8]}}),
  entry({type:'progress',category:'data',get label(){return L('进度条','Progress bar')},describe:'Share done (0-1), against where the plan expected it by now.',
    schema:block('progress',{title:text,actual:unit,expected:opt(unit)}),example:{type:'progress',title:'Done',actual:0.4,expected:0.6}}),
  entry({type:'ring',category:'data',get label(){return L('进度环','Progress ring')},describe:'Up to 8 progress rings, value 0-1.',
    schema:block('ring',{title:opt(str),items:list(z.object({label:stext,value:unit}),8)}),example:{type:'ring',items:[{label:'Design',value:0.8}]}}),
  entry({type:'gauge',category:'data',get label(){return L('仪表盘','Gauge')},describe:'A value on a dial from min to max.',
    schema:block('gauge',{title:text,value:num,min:num,max:num,unit:opt(str)}).refine(b=>b.max>b.min),
    example:{type:'gauge',title:'CPU',value:63,min:0,max:100,unit:'%'}}),
  entry({type:'plan-actual',category:'data',get label(){return L('计划 vs 实际','Plan vs actual')},describe:'Planned against actual per item; overruns are flagged.',
    schema:block('plan-actual',{title:text,items:list(z.object({label:stext,planned:num,actual:num,unit:or(str,'')}),LIST)}),
    example:{type:'plan-actual',title:'Budget',items:[{label:'Hotel',planned:800,actual:950,unit:'USD'}]}}),
  entry({type:'leaderboard',category:'data',get label(){return L('排行榜','Leaderboard')},describe:'Ranked by numeric value, highest first.',
    schema:block('leaderboard',{title:text,items:list(z.object({name:stext,value:num,note:opt(str)}),LIST)}),
    example:{type:'leaderboard',title:'Top pages',items:[{name:'/home',value:420},{name:'/docs',value:310}]}}),
  entry({type:'rating',category:'data',get label(){return L('评分','Rating')},describe:'A score 0-5 per item.',
    schema:block('rating',{title:opt(str),items:list(z.object({label:stext,score:between(0,5)}),LIST)}),example:{type:'rating',items:[{label:'Location',score:4.5}]}}),
  entry({type:'compare',category:'data',get label(){return L('对比','Comparison')},describe:'Options side by side; lean:true marks the one you lean to.',
    schema:block('compare',{title:text,options:list(z.object({name:text,value:opt(scalar),note:or(str,''),lean:opt(z.boolean())}),LIST)}),
    example:{type:'compare',title:'Hotels',options:[{name:'A',value:'$90',note:'Near',lean:true},{name:'B',note:'Cheap'}]}}),
  entry({type:'pros-cons',category:'data',get label(){return L('优缺点','Pros and cons')},describe:'Pros and cons as two lists.',
    schema:block('pros-cons',{title:opt(str),pros:many,cons:many}).refine(b=>b.pros.length+b.cons.length>0),example:{type:'pros-cons',pros:['Fast'],cons:['Costly']}}),
  entry({type:'checklist',category:'data',get label(){return L('清单','Checklist')},describe:'Items to tick, done true or false.',
    schema:block('checklist',{title:text,items:list(z.object({text,done:z.boolean()}),LIST)}),
    example:{type:'checklist',title:'Before leaving',items:[{text:'Book',done:true},{text:'Pack',done:false}]}}),
  entry({type:'choice',category:'data',get label(){return L('选择','Choice')},describe:'A question for the user; picking an option sends it to the assistant.',
    schema:block('choice',{question:text,options:list(text,LIST)}),example:{type:'choice',question:'Which route?',options:['East','West']}}),
] as const;

/** Spec §3: a table is a database now. Old pages still hold this one, so it is read but offered nowhere. Rows keep their place whatever
 * their cells hold; short ones are padded and long ones cut to the header, which is cut before it is read. */
export const TABLE=entry({type:'table',category:'data',get label(){return L('表格','Table')},describe:'Plain table of text; use database instead.',
  schema:block('table',{title:opt(str),columns:arr.refine(a=>a.length>0).transform(a=>a.slice(0,COLS).map(cell)),rows:list(arr.transform(a=>a.slice(0,COLS).map(cell)),ROWS)})
    .transform(b=>({...b,rows:b.rows.map(r=>b.columns.map((_,i)=>r[i]??''))})),
  example:{type:'table',columns:['Day','Plan'],rows:[['Mon','Kyoto']]}});
