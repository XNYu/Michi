import {CATALOG,validateBlock,CHART_KIND_LABELS,type ChartKind} from '../../shared/desk-catalog';
import type {PageBlockWithSources} from '../../shared/desk-blocks';
import type {DeskThread} from '../../shared/desk';
import {L} from '../../shared/i18n';

const now=new Date(),year=now.getFullYear(),month=`${year}-${String(now.getMonth()+1).padStart(2,'0')}`;
const day=(n:number)=>`${month}-${String(n).padStart(2,'0')}`;
const photo='https://images.unsplash.com/photo-1470770841072-f978cf4d019e?w=640&q=80';
const photo2='https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=640&q=80';
const series=[{label:L('已完成','Done'),points:[{x:L('周一','Mon'),y:8},{x:L('周二','Tue'),y:14},{x:L('周三','Wed'),y:11},{x:L('周四','Thu'),y:19},{x:L('周五','Fri'),y:24}]}];
const database={type:'database',title:L('本周计划',"This week's plan"),columns:[{id:'name',name:L('事项','Item'),type:'text'},{id:'state',name:L('状态','Status'),type:'select',options:L<{value:string;label?:string}[]>([{value:'进行中'},{value:'已完成'}],[{value:'进行中',label:'In progress'},{value:'已完成',label:'Done'}])}], // i18n-ok: option values, compared with the rows' state; English shows the label
  rows:[{id:'r1',values:{name:L('整理项目文档','Tidy up the project docs'),state:'已完成'}},{id:'r2',values:{name:L('设计组件预览','Design the component previews'),state:'进行中'}},{id:'r3',values:{name:L('检查交互细节','Check the interaction details'),state:'进行中'}}]}; // i18n-ok: state holds the option values above, shown by their label
/** Demonstration content, kept apart from docs' minimal API examples and from every real project. */
const samples:Record<string,unknown>={
  heading:{type:'heading',level:2,text:L('让想法有条不紊','Keep your ideas in order')},
  markdown:{type:'markdown',text:L('把散落的想法整理成 **清晰的下一步**。\n\n- 记录重要的决定\n- 把进展和依据放在一起\n- 留出时间，专注当下','Turn scattered ideas into **clear next steps**.\n\n- Write down the decisions that matter\n- Keep progress and its evidence together\n- Make time to focus on the present')},
  callout:{type:'callout',tone:'info',title:L('下一步已经清楚','The next step is clear'),text:L('先完成原型，再邀请两位同事一起体验。','Finish the prototype first, then invite two colleagues to try it.')},
  quote:{type:'quote',text:L('把复杂的事情，变成每天一点点可见的进展。','Turn complex work into a little visible progress every day.'),cite:L('项目笔记','Project notes')},
  toggle:{type:'toggle',title:L('本周的三个小目标','Three small goals for this week'),blocks:[{type:'markdown',text:L('完成原型、整理反馈、安排下一轮。','Finish the prototype, sort through the feedback, plan the next round.')}]},
  columns:{type:'columns',columns:[[{type:'stat',label:L('本周完成','Done this week'),value:'12',delta:'+4'}],[{type:'stat',label:L('进行中','In progress'),value:'5'}]]},
  tabs:{type:'tabs',tabs:[{label:L('概览','Overview'),blocks:[{type:'markdown',text:L('本周完成 **12 项任务**，设计与实现都在按计划推进。','**12 tasks** done this week. Design and build are both on track.')}]},{label:L('下一步','Next step'),blocks:[{type:'markdown',text:L('邀请试用，收集第一轮反馈。','Invite people to try it and gather the first round of feedback.')}]}]},
  code:{type:'code',lang:'ts',code:L('const nextStep = {\n  title: "把想法变成现实",\n  status: "in-progress",\n};','const nextStep = {\n  title: "Turn the idea into reality",\n  status: "in-progress",\n};')},
  diff:{type:'diff',before:'const status = "planned";\nconst progress = 0;',after:'const status = "building";\nconst progress = 72;'},
  math:{type:'math',tex:'\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}',display:true},
  mermaid:{type:'mermaid',code:L('graph LR\n A[想法] --> B[原型]\n B --> C[反馈]\n C --> D[发布]','graph LR\n A[Idea] --> B[Prototype]\n B --> C[Feedback]\n C --> D[Launch]')},
  keyvalue:{type:'keyvalue',title:L('项目速览','Project at a glance'),items:[{key:L('负责人','Owner'),value:L('林雨','Emma Clark')},{key:L('阶段','Stage'),value:L('原型验证','Prototype testing')},{key:L('下一次回顾','Next review'),value:L('周五 15:00','Fri 15:00')}]},
  tags:{type:'tags',items:[{label:L('设计','Design'),tone:'info'},{label:L('待反馈','Awaiting feedback'),tone:'warn'},{label:L('已完成','Done'),tone:'success'},{label:L('本周','This week')}]},
  metrics:{type:'metrics',items:[{label:L('进行中','In progress'),value:'5',hint:L('个项目','projects')},{label:L('本周完成','Done this week'),value:'12',hint:L('比上周多 4 项','4 more than last week')},{label:L('等待回复','Awaiting reply'),value:'2',tone:'warn'}]},
  stat:{type:'stat',label:L('本月专注时间','Focus time this month'),value:L('128 小时','128 hours'),delta:'+18.6%',deltaTone:'up',spark:[12,18,16,27,23,34,38]},
  progress:{type:'progress',title:L('发布准备','Launch prep'),actual:0.72,expected:0.85},
  ring:{type:'ring',title:L('每一步都有进展','Progress at every step'),items:[{label:L('设计','Design'),value:0.92},{label:L('开发','Development'),value:0.68},{label:L('验收','Sign-off'),value:0.35}]},
  gauge:{type:'gauge',title:L('本周专注度','Focus this week'),value:76,min:0,max:100,unit:'%'},
  'plan-actual':{type:'plan-actual',title:L('时间预算','Time budget'),items:[{label:L('设计','Design'),planned:16,actual:14,unit:L('小时','h')},{label:L('开发','Development'),planned:32,actual:36,unit:L('小时','h')},{label:L('测试','Testing'),planned:12,actual:8,unit:L('小时','h')}]},
  leaderboard:{type:'leaderboard',title:L('本周投入','Time spent this week'),items:[{name:L('产品设计','Product design'),value:24},{name:L('功能开发','Feature work'),value:18},{name:L('资料整理','Organizing notes'),value:11}]},
  rating:{type:'rating',title:L('试用反馈','Trial feedback'),items:[{label:L('易用性','Ease of use'),score:4.5},{label:L('视觉体验','Look and feel'),score:4},{label:L('响应速度','Speed'),score:5}]},
  compare:{type:'compare',title:L('选择工作方式','Choose a way to work'),options:[{name:L('专注时段','Focus block'),value:L('90 分钟','90 min'),note:L('适合设计与编写','Good for design and writing'),lean:true},{name:L('短任务','Short tasks'),value:L('25 分钟','25 min'),note:L('适合整理与回复','Good for tidying up and replies')}]},
  'pros-cons':{type:'pros-cons',title:L('先做一个小版本','Ship a small version first'),pros:L(['尽早得到真实反馈','更快交付核心体验'],['Real feedback early','The core experience ships sooner']),cons:L(['暂时只覆盖主要场景'],['Covers only the main cases for now'])},
  checklist:{type:'checklist',title:L('发布前的最后几步','Last steps before launch'),items:[{text:L('完成核心流程','Finish the core flow'),done:true},{text:L('整理使用说明','Write up the user guide'),done:true},{text:L('邀请首批用户','Invite the first users'),done:false}]},
  choice:{type:'choice',question:L('下一步先做什么？','What should come next?'),options:L(['完善体验','整理反馈','开始测试'],['Polish the experience','Sort through feedback','Start testing'])},
  chart:{type:'chart',kind:'bar',title:L('一周的进展','A week of progress'),series},
  timeline:{type:'timeline',items:[{at:L('周一','Mon'),title:L('确定方向','Set the direction'),text:L('把想法写成清晰的目标','Write the idea down as a clear goal')},{at:L('周三','Wed'),title:L('完成原型','Finish the prototype'),tone:'success'},{at:L('周五','Fri'),title:L('第一轮试用','First trial round')}]},
  milestones:{type:'milestones',title:L('从想法到发布','From idea to launch'),items:[{label:L('方案完成','Plan done'),date:day(3),done:true},{label:L('原型验证','Prototype tested'),date:day(12),done:true},{label:L('正式发布','Launch'),date:day(28),done:false}]},
  stepper:{type:'stepper',steps:[{label:L('想法','Idea')},{label:L('设计','Design')},{label:L('实现','Build')},{label:L('发布','Launch')}],current:2},
  agenda:{type:'agenda',date:day(20),items:[{time:'09:30',title:L('晨间规划','Morning planning')},{time:'11:00',title:L('产品设计回顾','Product design review')},{time:'15:00',title:L('与团队一起试用','Try it out with the team')}]},
  calendar:{type:'calendar',month,events:[{date:day(8),title:L('设计回顾','Design review')},{date:day(15),title:L('原型试用','Prototype trial')},{date:day(23),title:L('上线准备','Launch prep')}]},
  gantt:{type:'gantt',title:L('发布计划','Launch plan'),items:[{label:L('调研','Research'),start:day(1),end:day(6),done:1},{label:L('设计','Design'),start:day(5),end:day(12),done:0.85},{label:L('实现','Build'),start:day(10),end:day(23),done:0.55},{label:L('验收','Sign-off'),start:day(21),end:day(28),done:0.1}]},
  countdown:{type:'countdown',title:L('距离下一次发布','Until the next launch'),to:new Date(now.getTime()+8*86400000+3600000).toISOString()},
  clocks:{type:'clocks',zones:[{label:L('东京','Tokyo'),tz:'Asia/Tokyo'},{label:L('伦敦','London'),tz:'Europe/London'},{label:L('纽约','New York'),tz:'America/New_York'}]},
  image:{type:'image',url:photo,alt:L('山间湖泊','A lake in the mountains'),caption:L('给下一次旅程留一点想象','Leave a little room to imagine the next trip')},
  gallery:{type:'gallery',items:[{url:photo,alt:L('湖泊','Lake')},{url:photo2,alt:L('山峰','Mountain peak')}]},
  'before-after':{type:'before-after',before:photo,after:photo2,caption:L('拖动滑块，比较两种选择','Drag the slider to compare the two options')},
  carousel:{type:'carousel',items:[{url:photo,caption:L('第一站 · 湖边','First stop · By the lake')},{url:photo2,caption:L('第二站 · 山间','Second stop · In the mountains')}]},
  video:{type:'video',url:'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',caption:L('视频播放示例','Video playback example')},
  audio:{type:'audio',url:'https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3',caption:L('音频播放示例','Audio playback example')},
  embed:{type:'embed',url:'https://example.com',title:L('嵌入网页','Embedded page'),height:240},
  link:{type:'link',url:L('https://developer.mozilla.org/zh-CN/','https://developer.mozilla.org/en-US/'),title:L('让想法在 Web 上运行','Bring your ideas to the web'),description:L('查阅 Web 平台的文档、教程与参考。','Docs, tutorials and references for the web platform.'),site:'MDN Web Docs'},
  file:{type:'file',title:L('项目计划','Project plan'),path:'docs/project-plan.md',note:L('目标、关键节点与下一步','Goals, key milestones and next steps')},
  'thread-card':{type:'thread-card',threadId:'preview-design'},threads:{type:'threads',title:L('正在推进','In progress'),threadIds:['preview-design','preview-docs']},
  person:{type:'person',name:L('林雨','Emma Clark'),role:L('产品设计','Product design'),note:L('把想法变成易用的体验','Turns ideas into experiences that are easy to use')},place:{type:'place',name:L('京都站','Kyoto Station'),address:L('京都市下京区','Shimogyo Ward, Kyoto'),note:L('旅程的第一站','First stop of the trip')},
  actions:{type:'actions',buttons:L([{label:'整理下一步',prompt:'整理下一步'},{label:'总结进展',prompt:'总结进展'},{label:'比较方案',prompt:'比较方案'}],[{label:'Work out the next step',prompt:'Work out the next step'},{label:'Summarize progress',prompt:'Summarize progress'},{label:'Compare options',prompt:'Compare options'}])},
  form:{type:'form',title:L('为下一个目标留出空间','Make room for your next goal'),fields:[{key:'goal',label:L('目标名称','Goal name'),type:'text',required:true},{key:'hours',label:L('预计投入（小时）','Estimated time (hours)'),type:'number'},{key:'stage',label:L('当前阶段','Current stage'),type:'select',options:L(['想法','计划中','进行中'],['Idea','Planned','In progress'])}],prompt:L('帮我规划这个目标','Help me plan this goal'),submitLabel:L('创建目标','Create goal')},
  poll:{type:'poll',question:L('你最想先体验哪一项？','Which would you like to try first?'),options:L(['项目看板','智能摘要','自定义组件'],['Project board','Smart summaries','Custom components'])},
  database,'database-ref':{type:'database-ref',databaseId:'preview-plan',title:L('项目事项','Project items')},
  custom:{type:'custom',height:160,code:`<style>body{font:14px system-ui;padding:20px;color:#18181b}.label{color:#71717a;font-size:12px}h2{font-size:30px;margin:12px 0}progress{width:100%;accent-color:#2563eb}</style><div class="label">${L('每一小步，都算数','Every small step counts')}</div><h2>${L('今天，完成了 3 件事','3 things done today')}</h2><progress value="3" max="5"></progress>`},
};
export const SAMPLE_BLOCKS=new Map(CATALOG.map(entry=>{
  const block=validateBlock({...((samples[entry.type]??entry.example) as object),id:`preview-${entry.type}`});
  if(!block)throw new Error(`Invalid component sample: ${entry.type}`);
  return [entry.type,block] as const;
}));
export const SAMPLE_DATABASE=SAMPLE_BLOCKS.get('database') as Extract<PageBlockWithSources,{type:'database'}>;
export const SAMPLE_THREADS:DeskThread[]=[
  {id:'preview-design',projectId:'',title:L('完成组件展示页','Finish the components page'),state:'doing',lastActivityAt:null,idleDays:0,stoppedAt:L('已经完成第一版布局','The first layout is done'),next:L('检查不同宽度的效果','Check how it looks at different widths'),source:null},
  {id:'preview-docs',projectId:'',title:L('整理使用说明','Write up the user guide'),state:'waiting',lastActivityAt:null,idleDays:0,stoppedAt:L('等待一轮试用反馈','Waiting for a round of trial feedback'),next:null,source:null},
];
export function chartSample(kind:ChartKind):PageBlockWithSources{
  const title=CHART_KIND_LABELS[kind];
  const data:Record<ChartKind,object>={bar:{series},line:{series},area:{series},composite:{series:[{...series[0],as:'bar'}]},
    pie:{slices:[{label:L('设计','Design'),value:35},{label:L('开发','Development'),value:45},{label:L('测试','Testing'),value:20}],donut:true},
    scatter:{series:[{label:L('任务','Tasks'),points:[{x:2,y:4},{x:4,y:7},{x:5,y:5},{x:7,y:9}]}]},bubble:{series:[{label:L('项目','Projects'),points:[{x:2,y:4,z:12},{x:4,y:7,z:20},{x:7,y:6,z:8}]}]},
    radar:{axes:L(['设计','开发','测试','文档','协作'],['Design','Development','Testing','Docs','Collaboration']),series:[{label:L('本周','This week'),values:[8,9,6,7,8]}]},
    heatmap:{days:Array.from({length:28},(_,i)=>({date:day(i+1),value:(i*7+3)%10}))},
    funnel:{steps:[{label:L('想法','Ideas'),value:32},{label:L('计划','Planned'),value:24},{label:L('进行中','In progress'),value:16},{label:L('完成','Done'),value:12}]},sparkline:{values:[2,6,4,10,8,13,16,14,20]},
    sankey:L({nodes:[{name:'计划'},{name:'设计'},{name:'开发'},{name:'完成'}],links:[{source:'计划',target:'设计',value:12},{source:'计划',target:'开发',value:18},{source:'设计',target:'完成',value:12},{source:'开发',target:'完成',value:18}]},
      {nodes:[{name:'Plan'},{name:'Design'},{name:'Development'},{name:'Done'}],links:[{source:'Plan',target:'Design',value:12},{source:'Plan',target:'Development',value:18},{source:'Design',target:'Done',value:12},{source:'Development',target:'Done',value:18}]})};
  return validateBlock({type:'chart',id:`preview-chart-${kind}`,kind,title,...data[kind]})!;
}
