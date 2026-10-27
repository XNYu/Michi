import type {ReactNode} from 'react';
import {AreaChart,BarChart,BubbleChart,CompositeChart,DonutChart,FunnelChart,Heatmap,LineChart,PieChart,RadarChart,SankeyChart,ScatterChart,Sparkline} from '@mantine/charts';
import type {PageBlock} from '../../../../../shared/desk-blocks';
import {CHART_KIND_LABELS} from '../../../../../shared/desk-catalog/index';
import {L,locale} from '../../../../../shared/i18n';

export type ChartData=Extract<PageBlock,{type:'chart'}>;
type Kind=ChartData['kind'];
// bar, line and area share one member of the union, so Extract on a single kind finds nothing.
type Of<K extends Kind>=ChartData extends infer C?C extends {kind:infer X}?K extends X?C:never:never:never;

/** Spec §6: the accent, then greys (each ≥ 3:1 on white); status colours never stand for a series. The first five are the old chart's; the rest only keep ten series
 * apart, since the legend and the tooltip carry who is who. */
// The values are --desk-chart-0…9 and --desk-ramp-0…3 in desk.css, which night mode swaps for its own; a variable is what lets the SVG follow it.
const COLORS=Array.from({length:10},(_,i)=>`var(--desk-chart-${i})`);
const color=(i:number)=>COLORS[i%COLORS.length];
const RAMP=Array.from({length:4},(_,i)=>`var(--desk-ramp-${i})`);
const H=220,DOTS=24,fmt=(n:number)=>n.toLocaleString(locale());
const label=(s:string,i:number)=>s||L(`系列 ${i+1}`,`Series ${i+1}`);
/** recharts draws in light grey by default, below 4.5:1 for 12px text. */
const look={textColor:'var(--desk-meta-soft)',h:'100%'} as const;

type Row=Record<string,string|number|undefined>;
/** A label may hold dots and spaces, which a dataKey cannot, so series are s0, s1… and the label rides along. */
const keyed=(series:{label:string}[])=>series.map((s,i)=>({name:`s${i}`,label:label(s.label,i),color:color(i)}));
/** One row per x, the x of every series in the order first seen; a series that lacks an x leaves a gap there, and one that repeats it keeps the last. */
function rows(series:{points:{x:string;y:number}[]}[]):Row[]{
  const at=series.map(s=>new Map(s.points.map(p=>[p.x,p.y]))),xs=new Set(series.flatMap(s=>s.points.map(p=>p.x)));
  return [...xs].map(x=>({x,...Object.fromEntries(at.map((m,i)=>[`s${i}`,m.get(x)]))}));
}
const slices=(list:{label:string;value:number}[])=>list.map((s,i)=>({name:s.label,value:s.value,color:color(i)}));

const bar=(c:Of<'bar'>)=><BarChart {...look} data={rows(c.series)} dataKey="x" series={keyed(c.series)} type={c.stacked?'stacked':'default'} valueFormatter={fmt}/>;
const line=(c:Of<'line'>)=>{const data=rows(c.series);return <LineChart {...look} data={data} dataKey="x" series={keyed(c.series)} withDots={data.length<=DOTS} valueFormatter={fmt}/>;};
const area=(c:Of<'area'>)=>{const data=rows(c.series);return <AreaChart {...look} data={data} dataKey="x" series={keyed(c.series)} type={c.stacked?'stacked':'default'} withDots={data.length<=DOTS} valueFormatter={fmt}/>;};
const composite=(c:Of<'composite'>)=>{const data=rows(c.series);
  return <CompositeChart {...look} data={data} dataKey="x" series={keyed(c.series).map((s,i)=>({...s,type:c.series[i].as}))} withDots={data.length<=DOTS} valueFormatter={fmt}/>;};
// A pie and a donut are squares of their own size, so they take the box's height.
const pie=(c:Of<'pie'>)=>{const p={data:slices(c.slices),size:H,withTooltip:true,valueFormatter:fmt};return c.donut?<DonutChart {...p}/>:<PieChart {...p}/>;};
const scatter=(c:Of<'scatter'>)=><ScatterChart {...look} dataKey={{x:'x',y:'y'}} data={c.series.map((s,i)=>({name:label(s.label,i),color:color(i),data:s.points.map(p=>({x:p.x,y:p.y}))}))} valueFormatter={fmt}/>;

type Dot={s:string;c:string;x:number;y:number;z:number};
const dotTip=({active,payload}:{active?:boolean;payload?:readonly {payload?:unknown}[]})=>{const d=active?payload?.[0]?.payload as Dot|undefined:undefined;
  return d?<div className="desk-chart-tip"><b>{d.s}</b><span>{L(`x ${fmt(d.x)}，y ${fmt(d.y)}${d.z===1?'':`，大小 ${fmt(d.z)}`}`,`x ${fmt(d.x)}, y ${fmt(d.y)}${d.z===1?'':`, size ${fmt(d.z)}`}`)}</span></div>:null;};
/** Mantine's bubble chart draws one colour and a category x axis (a timeline of rows), so this one puts a number axis under it and colours each bubble itself;
 * a point with no size is a plain dot. */
const bubble=(c:Of<'bubble'>)=>{
  const data:Dot[]=c.series.flatMap((s,i)=>s.points.map(p=>({s:label(s.label,i),c:color(i),x:p.x,y:p.y,z:p.z??1})));
  return <BubbleChart {...look} data={data} dataKey={{x:'x',y:'y',z:'z'}} range={[40,400]} valueFormatter={fmt}
    xAxisProps={{type:'number',domain:['auto','auto'],tickFormatter:fmt}} yAxisProps={{width:48,tick:{fontSize:12,fill:'currentColor'},tickFormatter:fmt}}
    tooltipProps={{content:dotTip}}
    scatterProps={{shape:(p:{cx?:number;cy?:number;size?:number;payload?:Dot})=><circle cx={p.cx} cy={p.cy} r={Math.sqrt((p.size??0)/Math.PI)} fill={p.payload?.c} fillOpacity={.7}/>}}/>;
};
const radar=(c:Of<'radar'>)=><RadarChart {...look} data={c.axes.map((a,j)=>({axis:a,...Object.fromEntries(c.series.map((s,i)=>[`s${i}`,s.values[j]]))}))}
  dataKey="axis" series={keyed(c.series)} withTooltip withPolarRadiusAxis/>;

const MONTHS=L(Array.from({length:12},(_,i)=>`${i+1}月`),['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']),WEEKDAYS=L(['日','一','','三','','五',''],['Sun','Mon','','Wed','','Fri','']);
/** A year at most: the calendar is a cell per day, so a stray old date would otherwise stretch it for decades. */
const heatmap=(c:Of<'heatmap'>)=>{
  const data:Record<string,number>={};for(const d of c.days)data[d.date]=(data[d.date]??0)+d.value;
  const dates=Object.keys(data).sort(),end=dates[dates.length-1],floor=new Date(Date.parse(end)-370*864e5).toISOString().slice(0,10);
  return <Heatmap data={data} startDate={dates[0]<floor?floor:dates[0]} endDate={end} colors={RAMP} firstDayOfWeek={1} withMonthLabels monthLabels={MONTHS} withWeekdayLabels weekdayLabels={WEEKDAYS}
    withTooltip getTooltipLabel={({date,value})=>L(`${date}：${value==null?'没有':fmt(value)}`,`${date}: ${value==null?'none':fmt(value)}`)} withLegend legendLabels={L(['少','多'],['Less','More'])}/>;
};
const funnel=(c:Of<'funnel'>)=><FunnelChart data={slices(c.steps)} size={H} withTooltip valueFormatter={fmt}/>;
const sparkline=(c:Of<'sparkline'>)=><Sparkline h="100%" w="100%" data={c.values} color={COLORS[0]} curveType="monotone"/>;
const sankey=(c:Of<'sankey'>)=>{
  const at=new Map(c.nodes.map((n,i)=>[n.name,i]));
  return <SankeyChart textColor={look.textColor} height={H} data={{nodes:c.nodes.map((n,i)=>({name:n.name,color:color(i)})),links:c.links.map(l=>({source:at.get(l.source)!,target:at.get(l.target)!,value:l.value}))}} valueFormatter={fmt}/>;
};

const DRAW:{[K in Kind]:(c:Of<K>)=>ReactNode}={bar,line,area,composite,pie,scatter,bubble,radar,heatmap,funnel,sparkline,sankey};

const empty=(c:ChartData)=>{switch(c.kind){
  case 'pie':return !c.slices.length;case 'funnel':return !c.steps.length;case 'heatmap':return !c.days.length;case 'sparkline':return c.values.length<2;
  case 'sankey':return !c.links.length;case 'radar':return !c.series.length||!c.axes.length;
  default:return !c.series.some(s=>s.points.length);
}};
/** What the legend names: the series when there are several, the slices or steps with their numbers (the chart alone does not say which is which). */
function legend(c:ChartData):{text:string;value?:number}[]{switch(c.kind){
  case 'pie':return c.slices.map(s=>({text:s.label,value:s.value}));
  case 'funnel':return c.steps.map(s=>({text:s.label,value:s.value}));
  case 'heatmap':case 'sparkline':case 'sankey':return [];
  default:return c.series.length>1?c.series.map((s,i)=>({text:label(s.label,i)})):[];
}}

/** What a screen reader gets in place of the picture: the numbers of the charts that have a table's shape. */
function Table({title,series}:{title:string;series:{label:string;points:{x:string;y:number}[]}[]}){
  return <table className="desk-sr"><caption>{title}</caption>
    <thead><tr><th scope="col"/>{series.map((s,i)=><th key={i} scope="col">{label(s.label,i)}</th>)}</tr></thead>
    <tbody>{rows(series).map(r=><tr key={r.x}><th scope="row">{r.x}</th>{series.map((_,i)=>{const v=r[`s${i}`];return <td key={i}>{typeof v==='number'?fmt(v):''}</td>;})}</tr>)}</tbody>
  </table>;
}

/** The chart for a block, in a box of fixed height; the legend is ours, as recharts draws nothing (legend included) until it has measured a box. */
export function Chart({block:c}:{block:ChartData}){
  if(empty(c))return <p className="desk-quiet">{L('没有数据','No data')}</p>;
  const names=legend(c),tabular=c.kind==='bar'||c.kind==='line'||c.kind==='area'||c.kind==='composite';
  return <div className="desk-chart">
    <div className="desk-chart-box" data-kind={c.kind} role="img" aria-label={L(`${c.title}（${CHART_KIND_LABELS[c.kind]}）`,`${c.title} (${CHART_KIND_LABELS[c.kind]})`)}>{(DRAW[c.kind] as (c:ChartData)=>ReactNode)(c)}</div>
    {names.length>0&&<ul className="desk-chart-legend">{names.map((n,i)=><li key={i}><span className="desk-chart-swatch" style={{background:color(i)}} aria-hidden="true"/>{n.text}{n.value!==undefined&&<b>{fmt(n.value)}</b>}</li>)}</ul>}
    {tabular&&<Table title={c.title} series={c.series}/>}
  </div>;
}

/** A stat block's trend line, here so it comes with the charts' chunk rather than with the page. */
export const StatSpark=({data}:{data:number[]})=><Sparkline data={data} h={40} color="var(--accent)" strokeWidth={1.5} fillOpacity={.12} withGradient={false}/>;
