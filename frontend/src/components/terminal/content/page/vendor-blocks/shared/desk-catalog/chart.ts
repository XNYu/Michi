import {z} from 'zod';
import {L} from '../i18n.ts';
import {LIST,SCAN,arr,base,day,entry,list,num,opt,or,scalar,stext,str,text} from './fields.ts';

export const CHART_KINDS=['bar','line','area','composite','pie','scatter','bubble','radar','heatmap','funnel','sparkline','sankey'] as const;
export type ChartKind=typeof CHART_KINDS[number];
/** One catalog entry draws twelve kinds of chart; the「+」menu names each. */
export const CHART_KIND_LABELS:Record<ChartKind,string>={get bar(){return L('柱状图','Bar chart')},get line(){return L('折线图','Line chart')},get area(){return L('面积图','Area chart')},
  get composite(){return L('组合图','Combo chart')},get pie(){return L('饼图 / 环图','Pie / donut chart')},get scatter(){return L('散点图','Scatter plot')},get bubble(){return L('气泡图','Bubble chart')},
  get radar(){return L('雷达图','Radar chart')},get heatmap(){return L('热力日历','Heatmap calendar')},get funnel(){return L('漏斗图','Funnel chart')},get sparkline(){return L('迷你图','Sparkline')},
  get sankey(){return L('桑基图','Sankey diagram')}};
const SERIES=10,POINTS=100,AXES=12,DAYS=400,XY=['bar','line','area'] as const;
const head={...base,type:z.literal('chart'),title:text},points=list(z.object({x:scalar,y:num}),POINTS);
/** Each kind reads only its own data; bar and line are the shape old pages already hold, so they need no migration. */
const kinds=z.discriminatedUnion('kind',[
  z.object({...head,kind:z.enum(XY),series:list(z.object({label:str,points}),SERIES),stacked:opt(z.boolean())}),
  z.object({...head,kind:z.literal('composite'),series:list(z.object({label:str,as:or(z.enum(XY),'line' as const),points}),SERIES)}),
  z.object({...head,kind:z.literal('pie'),slices:list(z.object({label:stext,value:num.min(0)}),LIST),donut:opt(z.boolean())}),
  z.object({...head,kind:z.enum(['scatter','bubble']),series:list(z.object({label:str,points:list(z.object({x:num,y:num,z:opt(num)}),POINTS)}),SERIES)}),
  // A value out of place would shift every one after it to the wrong axis, so a series is all numbers or nothing.
  z.object({...head,kind:z.literal('radar'),axes:list(stext,AXES,3),series:list(z.object({label:str,values:arr.refine(a=>a.length<=AXES*SCAN).pipe(z.array(num))}),SERIES)}),
  z.object({...head,kind:z.literal('heatmap'),days:list(z.object({date:day,value:num}),DAYS)}),
  z.object({...head,kind:z.literal('funnel'),steps:list(z.object({label:stext,value:num.min(0)}),LIST)}),
  z.object({...head,kind:z.literal('sparkline'),values:list(num,POINTS,2)}),
  z.object({...head,kind:z.literal('sankey'),nodes:list(z.object({name:stext}),LIST,2),links:list(z.object({source:stext,target:stext,value:num.positive()}),LIST*2)}),
]);
type Kinds=z.output<typeof kinds>;
type Link={source:string;target:string;value:number};
/** Links in the order written, less any that would close a loop (A→A, A→B→A, or longer): the drawing walks each path to its end and never
 * would. The first links win; the one closing the loop goes. */
function acyclic<L extends Link>(links:L[]):L[]{
  const next=new Map<string,string[]>();
  const reaches=(from:string,to:string)=>{const seen=new Set([from]),stack=[from];
    while(stack.length){const n=stack.pop()!;if(n===to)return true;for(const m of next.get(n)??[])if(!seen.has(m)){seen.add(m);stack.push(m);}}return false;};
  return links.filter(l=>{if(reaches(l.target,l.source))return false;next.set(l.source,[...next.get(l.source)??[],l.target]);return true;});
}
/** What needs the whole chart to judge: a radar series needs a value per axis (extra ones are cut), and a sankey link names two other
 * nodes, by name or by their place in the list as written; links to nowhere and loops go. */
function fit(c:Kinds):Kinds{
  if(c.kind==='radar'){const n=c.axes.length;return {...c,series:c.series.filter(s=>s.values.length>=n).map(s=>({...s,values:s.values.slice(0,n)}))};}
  if(c.kind!=='sankey')return c;
  const names=new Set(c.nodes.map(x=>x.name)),node=(s:string)=>names.has(s)?s:/^\d+$/.test(s)?c.nodes[Number(s)]?.name:undefined;
  const links=acyclic(c.links.flatMap(l=>{const source=node(l.source),target=node(l.target);return source&&target?[{...l,source,target}]:[];}));
  return {...c,nodes:[...names].map(name=>({name})),links};
}
const shown=(c:Kinds)=>c.kind==='radar'?c.series.length>0:c.kind==='sankey'?c.links.length>0&&c.nodes.length>1:c.kind==='pie'?c.slices.some(s=>s.value>0):true;

export const CHART=[
  entry({type:'chart',category:'chart',get label(){return L('图表','Chart')},
    describe:'Chart; kind picks the data. bar, line, area: series [{label, points [{x, y}]}], stacked?. composite: series also take as: bar, line or area. '+
      'pie: slices [{label, value}], donut?. scatter, bubble: series [{label, points [{x, y, z?}]}] all numbers. radar: axes (3+ names), series [{label, values (one per axis)}]. '+
      'heatmap: days [{date YYYY-MM-DD, value}]. funnel: steps [{label, value}]. sparkline: values (numbers). sankey: nodes [{name}], links [{source, target, value}] by node name.',
    schema:kinds.transform(fit).refine(shown),
    example:{type:'chart',kind:'bar',title:'Tasks per week',series:[{label:'Done',points:[{x:'W1',y:3},{x:'W2',y:5}]}]}}),
] as const;
