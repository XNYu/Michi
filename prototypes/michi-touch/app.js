import { ThoughtTree } from './tree.js';

const $ = s => document.querySelector(s);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
const STORE = 'michi-touch-study-v1';
const initialNodes = [
  {id:'root',parent:null,title:'思考的花园',summary:'如果对话不止是一条线',kind:'root'},
  {id:'space',parent:'root',title:'空间，而不是列表',summary:'给每一个念头，一个位置',kind:'space'},
  {id:'gesture',parent:'root',title:'让交互变得自然',summary:'长按、分岔，然后继续',kind:'gesture'},
  {id:'quiet',parent:'space',title:'安静的界面',summary:'只在需要的时候，轻轻出现',kind:'quiet'},
  {id:'physics',parent:'gesture',title:'一点点物理感',summary:'弹簧、阻尼，和那一下 duang',kind:'physics'},
];
const fresh = () => ({version:1,current:'root',nodes:structuredClone(initialNodes),comments:{},messages:{},scroll:{}});
let state=fresh(), storageWorks=true;
try {
  const saved=JSON.parse(localStorage.getItem(STORE)||'null');
  if(saved?.version===1&&Array.isArray(saved.nodes)&&saved.nodes.some(n=>n.id==='root')&&saved.nodes.every((n,i,a)=>typeof n.id==='string'&&typeof n.title==='string'&&a.findIndex(p=>p.id===n.id)===i&&(n.parent===null||(a.findIndex(p=>p.id===n.parent)>=0&&a.findIndex(p=>p.id===n.parent)<i)))) {
    state={...fresh(),...saved};
    if(!state.nodes.some(n=>n.id===state.current))state.current='root';
  }
} catch { storageWorks=false; }
function save(){try{localStorage.setItem(STORE,JSON.stringify(state));}catch{storageWorks=false;toast('浏览器未允许保存，本次操作仍可继续');}}
const device=$('#device'), content=$('#page-content'), scroll=$('#page-scroll');
const page=$('#page-surface'), panel=$('#tree-panel'), trigger=$('#tree-trigger');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
const tree=new ThoughtTree($('#tree-viewport'),$('#tree-labels'),id=>selectNode(id));
let selected=null, selectionAnchor=null, sheetRestore=null, toastTimer;
let selectionPointerId=null, selectionDismissAfter=0;
let treeOpen=false, pull=null, press=null, pressTimer;
const reveal={value:0,velocity:0,target:0};
const lift={value:1,velocity:0,target:1};

function toast(message){$('#toast').textContent=message;$('#toast').classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),2400);}
function caption(text){$('#live-caption').textContent=text;}
function haptic(){navigator.vibrate?.(8);}
function block(id,type,html,tag='p',classes=''){
  return `<${tag} class="content-block ${classes}" data-block="${id}" data-kind="${type}" tabindex="0" aria-label="${type}，长按或按空格展开操作">${html}</${tag}>`;
}
const photo=()=>block('mountain','图片',`<img src="./assets/mountain.jpg" alt="云雾中层层展开的山脊" draggable="false"><figcaption>同一片风景，可以有不止一种抵达的方式。</figcaption>`,'figure','image-block');
const code=()=>block('code','代码',`<div class="code-meta"><span>THOUGHT.TS</span><span>一种可能</span></div><pre><span>const</span> next = thought.branch({
  from: selectedBlock,
  direction: 'what if…'
});

// 好奇心，值得有自己的空间。</pre>`,'div','code-block');
const table=()=>`<table class="block-table"><thead><tr><th>你的动作</th><th>念头去哪里</th></tr></thead><tbody><tr>${block('action-branch','表格单元格','长按 → Branch','td')}${block('table-branch','表格单元格','长出一条新路径，保留来处。','td')}</tr><tr>${block('action-comment','表格单元格','长按 → Comment','td')}${block('table-comment','表格单元格','在原地留下一个小小的想法。','td')}</tr><tr>${block('action-tree','表格单元格','拉开分支树','td')}${block('table-tree','表格单元格','退后一步，看见思考的全貌。','td')}</tr></tbody></table>`;
function rootBody(){return `
  <div class="page-kicker">一场关于思考的漫游</div>
  <h1>如果思路，<br>可以自由生长。</h1>
  <p class="lede">有些念头，值得暂时走远一点。</p>
  ${block('question','段落','如果对话不止是一条线，<br>会是什么样？','div','user-question')}
  <div class="response-author"><span class="tiny-brand">m</span> Michi <time>刚刚</time></div>
  ${block('garden','段落','也许，对话可以像一座<strong>花园</strong>。你沿着一条路往前走，忽然被旁边的一片风景吸引。不必放弃原来的路，只需要轻轻拐个弯。')}
  ${block('thought','段落','一个念头，可以长出另一个念头。<strong>原来的对话留在原地，新的可能有了自己的空间。</strong>想回来的时候，来路也一直清晰。')}
  ${photo()}
  <h2 class="content-subheading">让好奇心，有地方落脚。</h2>
  ${block('moment','段落','不论是一句话、一段代码，还是一张图，按住它的那一刻，就是新路径的起点。界面只需要在这个时候，轻轻出现。')}
  ${code()}${table()}
  ${block('end','段落','你始终决定往哪里走。所有分支都可以保留，不需要急着收束成唯一的答案。')}`;}
const bodies={
  space:()=>`${block('space-1','段落','列表擅长记录先后，<strong>空间擅长保留关系。</strong>当你同时探索几个问题，重要的往往不是“哪一条最新”，而是“这个念头从哪里来”。')}${photo()}${block('space-2','段落','把分支放回一棵树上，每一个页面都有位置。打开全貌，是暂时退后一步；轻点一张卡片，就重新走进那个问题。')}${block('space-3','段落','树应该是随时能拉开的一张地图。探索时看见它，思考时让它退到一旁。')}`,
  gesture:()=>`${block('gesture-1','段落','<strong>长按，是把注意力交给一小块内容。</strong>不用瞄准细小的文字光标，也不用先进入编辑模式。手指停在哪里，想法就从哪里开始。')}${block('gesture-2','段落','按下时给一点反馈，约 420 毫秒后托起最近的内容块。若手指开始滚动，就取消长按，让阅读保持顺畅。')}${table()}${block('gesture-3','段落','Branch 让你走到另一个空间；Comment 让想法留在原地。这两个动作，可以共享同一个很轻的入口。')}`,
  quiet:()=>`${block('quiet-1','段落','安静，不等于什么都没有。<strong>它意味着界面知道什么时候该退后。</strong>读内容时只留下内容；产生新的念头时，再把可能的动作送到手边。')}${block('quiet-2','段落','树按钮放在右上角：平时是一个小小的方位标记。点击展开，或用手指把整个思路空间拉出来。')}${photo()}${block('quiet-3','段落','颜色用于告诉你“现在在哪里”，不是为了让每一条分支争夺注意力。')}`,
  physics:()=>`${block('physics-1','段落','那一下 <strong>duang</strong>，不需要很夸张。内容稍微浮起来，菜单顺势出现，你就能理解：这一小块，已经被拿在手里了。')}${code()}${block('physics-2','段落','拉开分支树时，画面应该紧跟手指。松手后带着原来的速度继续，像一个有重量、可以随时被接住的物体。')}${block('physics-3','段落','运动可以被打断，也可以被反向带回。开启系统的“减少动态效果”时，用直接切换保留同样的层级关系。')}`,
};

function renderPage(){
  const n=state.nodes.find(n=>n.id===state.current);
  $('#nav-title').textContent=n.title;$('#nav-subtitle').textContent=n.parent?'一条新的思路':'主线';
  $('#switcher-title').textContent=n.title;
  trigger.hidden=state.nodes.length<2;
  $('#branch-count').textContent=state.nodes.length;
  $('#tree-count').textContent=String(state.nodes.length).padStart(2,'0');
  if(n.kind==='root')content.innerHTML=rootBody();
  else{
    const parent=state.nodes.find(p=>p.id===n.parent);
    content.innerHTML=`<button class="parent-link" data-parent="${escape(n.parent)}">${icon('back')}来自「${escape(parent?.title||'主线')}」</button><div class="page-kicker">${icon('branch')} 一个新的方向</div><h1>${escape(n.title)}</h1><p class="lede">${escape(n.summary)}</p>${n.source?`<div class="branch-source"><small>从这里开始 · ${escape(n.source.kind)}</small><p>${escape(n.source.text)}</p></div>`:''}<div class="response-author"><span class="tiny-brand">m</span> Michi <time>${n.kind?'一段探索':'新的分支'}</time></div>${bodies[n.kind]?.()||block('new-start','段落','这条路刚刚开始。你可以在下面继续记录，也可以长按这段话，再生出一个分支。')}`;
  }
  const messages=state.messages[state.current]||[];
  content.insertAdjacentHTML('beforeend',`<div class="message-list">${messages.map((m,i)=>`${block('user-message-'+i,'段落',escape(m),'div','user-question')}${block('message-'+i,'段落','已留在这条思路中。你可以长按这段记录继续分支。<br><span class="demo-reply">这是交互原型中的示例回应。</span>')}`).join('')}</div><div class="hold-hint">${icon('hand')}长按任何内容 · 或选中后按空格</div>`);
  content.querySelector('[data-parent]')?.addEventListener('click',e=>selectNode(e.currentTarget.dataset.parent));
  renderCommentBadges();
  scroll.scrollTop=state.scroll[state.current]||0;
  tree.setData(state.nodes,state.current);
}
function selectNode(id){
  if(!state.nodes.some(n=>n.id===id))return;
  state.scroll[state.current]=scroll.scrollTop;
  closeSelection(false);closeSheet(false);
  const changed=state.current!==id;
  state.current=id;renderPage();save();setTree(false);
  if(changed){
    if(!reduced.matches)content.animate([{opacity:.2,transform:'translateY(10px)'},{opacity:1,transform:'translateY(0)'}],{duration:230,easing:'cubic-bezier(.2,.7,.2,1)'});
    caption(`当前：${state.nodes.find(n=>n.id===id).title}`);
  }
}

function setTree(open){
  closeSelection(false);closeSheet(false);cancelPress();
  treeOpen=open;reveal.target=open?1:0;
  trigger.setAttribute('aria-expanded',String(open));
  panel.inert=!open;page.inert=open;
  if(open){tree.setActive(true);caption('拖动整棵树，轻点一张卡片切换。');$('#close-tree').focus({preventScroll:true});}
  else {trigger.focus({preventScroll:true});caption('可以点，也可以按住。试试看。');}
}
let closeDragged=false;
$('#close-tree').addEventListener('click',()=>{if(!closeDragged)setTree(false);closeDragged=false;});
$('#try-tree').addEventListener('click',()=>setTree(true));
$('#go-root').addEventListener('click',()=>selectNode('root'));
$('#fit-tree').addEventListener('click',()=>tree.fit());
$('#zoom-in').addEventListener('click',()=>tree.zoom(1.25));
$('#zoom-out').addEventListener('click',()=>tree.zoom(.8));
trigger.addEventListener('pointerdown',e=>{
  if(e.button!==0)return;
  trigger.setPointerCapture(e.pointerId);
  pull={x:e.clientX,y:e.clientY,start:reveal.value,last:reveal.value,time:performance.now(),moved:false,velocity:0};
  reveal.velocity=0;tree.setActive(true);
});
trigger.addEventListener('pointermove',e=>{
  if(!pull)return;
  const dx=pull.x-e.clientX,dy=e.clientY-pull.y;
  if(Math.hypot(dx,dy)>6)pull.moved=true;
  if(!pull.moved)return;
  const value=clamp(pull.start+(dx*.7+dy)/200,0,1.06);
  const now=performance.now();pull.velocity=(value-pull.last)/Math.max((now-pull.time)/1000,.008);
  pull.last=value;pull.time=now;reveal.value=value;
});
function endPull(cancelled=false){
  if(!pull)return;
  const p=pull;pull=null;
  if(cancelled){setTree(treeOpen);return;}
  if(!p.moved){setTree(!treeOpen);return;}
  reveal.velocity=clamp(performance.now()-p.time<100?p.velocity:0,-5,5);
  setTree(reveal.value+reveal.velocity*.14>.4);
}
trigger.addEventListener('pointerup',()=>endPull());trigger.addEventListener('pointercancel',()=>endPull(true));
trigger.addEventListener('click',e=>{if(e.detail===0)setTree(!treeOpen);});
// The close control doubles as a reverse pull handle; it remains available mid-animation.
let closePull=null;
$('#close-tree').style.touchAction='none';
$('#close-tree').addEventListener('pointerdown',e=>{closeDragged=false;closePull={x:e.clientX,y:e.clientY,start:reveal.value,moved:false,last:reveal.value,time:performance.now(),velocity:0};e.currentTarget.setPointerCapture(e.pointerId);});
$('#close-tree').addEventListener('pointermove',e=>{if(!closePull)return;const dx=e.clientX-closePull.x,dy=closePull.y-e.clientY;if(Math.hypot(dx,dy)>6)closePull.moved=true;if(!closePull.moved)return;const now=performance.now(),v=clamp(closePull.start-(dx*.7+dy)/200,0,1);closePull.velocity=(v-closePull.last)/Math.max((now-closePull.time)/1000,.008);closePull.last=v;closePull.time=now;reveal.value=v;});
$('#close-tree').addEventListener('pointerup',e=>{if(!closePull)return;const p=closePull;closePull=null;if(p.moved){closeDragged=true;e.preventDefault();reveal.velocity=p.velocity;setTree(reveal.value+p.velocity*.1>.55);}});
$('#close-tree').addEventListener('pointercancel',()=>{closePull=null;setTree(treeOpen);});

function adjacentPage(direction){const index=state.nodes.findIndex(n=>n.id===state.current);selectNode(state.nodes[(index+direction+state.nodes.length)%state.nodes.length].id);haptic();}
$('#previous-page').addEventListener('click',()=>adjacentPage(-1));
$('#next-page').addEventListener('click',()=>adjacentPage(1));
let switchSwipe=null;
$('#tree-switcher').addEventListener('pointerdown',e=>{if(e.target.closest('button'))return;switchSwipe={x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId);});
$('#tree-switcher').addEventListener('pointermove',e=>{if(!switchSwipe)return;const dx=e.clientX-switchSwipe.x;$('#tree-switcher>div').style.transform=reduced.matches?'none':`translateX(${clamp(dx*.4,-35,35)}px)`;});
$('#tree-switcher').addEventListener('pointerup',e=>{if(!switchSwipe)return;const dx=e.clientX-switchSwipe.x,dy=e.clientY-switchSwipe.y;switchSwipe=null;$('#tree-switcher>div').style.transform='';if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.4)adjacentPage(dx<0?1:-1);});
$('#tree-switcher').addEventListener('pointercancel',()=>{switchSwipe=null;$('#tree-switcher>div').style.transform='';});

function nearestBlock(x,y,target){
  const direct=target.closest('[data-block]');if(direct)return direct;
  let winner=null,distance=Infinity;
  for(const b of content.querySelectorAll('[data-block]')){
    const r=b.getBoundingClientRect();
    const dx=Math.max(r.left-x,0,x-r.right),dy=Math.max(r.top-y,0,y-r.bottom),d=Math.hypot(dx,dy);
    if(d<distance&&d<=32){winner=b;distance=d;}
  }
  return winner;
}
function cancelPress(){clearTimeout(pressTimer);press?.block.classList.remove('pressing');press=null;}
scroll.addEventListener('pointerdown',e=>{
  if(e.button!==0||e.target.closest('button,a,input,textarea'))return;
  cancelPress();const b=nearestBlock(e.clientX,e.clientY,e.target);if(!b)return;
  press={block:b,x:e.clientX,y:e.clientY,id:e.pointerId};
  b.classList.add('pressing');
  pressTimer=setTimeout(()=>{if(press){const target=press.block,id=press.id;cancelPress();openSelection(target,id);haptic();}},420);
});
scroll.addEventListener('pointermove',e=>{if(press&&Math.hypot(e.clientX-press.x,e.clientY-press.y)>9)cancelPress();});
for(const event of ['pointerup','pointercancel','lostpointercapture'])window.addEventListener(event,e=>{
  cancelPress();
  if(e.type!=='lostpointercapture'&&e.pointerId===selectionPointerId){selectionPointerId=null;selectionDismissAfter=performance.now()+350;}
});
scroll.addEventListener('scroll',cancelPress,{passive:true});
content.addEventListener('contextmenu',e=>{const b=nearestBlock(e.clientX,e.clientY,e.target);if(b){e.preventDefault();cancelPress();openSelection(b);}});
content.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&e.target.matches('[data-block]')){e.preventDefault();openSelection(e.target);}});

function openSelection(b,pointerId=null){
  if(treeOpen||!$('#sheet-layer').hidden)return;
  selectionPointerId=pointerId;selectionDismissAfter=pointerId===null?0:Infinity;
  const clean=b.cloneNode(true);clean.querySelectorAll('.comment-badge').forEach(x=>x.remove());
  selected={blockId:b.dataset.block,kind:b.dataset.kind,text:clean.innerText.trim()||b.querySelector('img')?.alt||'图片',nodeId:state.current};
  selectionAnchor=b;
  const rect=b.getBoundingClientRect(),frame=device.getBoundingClientRect(),layer=$('#selection-layer');
  layer.hidden=false;page.inert=true;
  const layerRect=layer.getBoundingClientRect(),preview=$('#selection-preview'),menu=$('#selection-menu');
  const pad=15,width=Math.min(rect.width+pad*2,device.clientWidth-28);
  const left=clamp(rect.left-layerRect.left-pad,14,device.clientWidth-width-14);
  preview.style.width=width+'px';preview.style.left=left+'px';preview.replaceChildren();
  clean.removeAttribute('tabindex');clean.removeAttribute('aria-label');clean.classList.remove('pressing');
  if(clean.tagName==='TD'){const div=document.createElement('div');div.textContent=clean.textContent;preview.append(div);}else preview.append(clean);
  preview.style.maxHeight=Math.min(layer.clientHeight-150,330)+'px';
  const height=preview.getBoundingClientRect().height;
  let top=clamp(rect.top-layerRect.top-pad,14,layer.clientHeight-height-115);
  preview.style.top=top+'px';
  $('#selection-type').textContent=`已选中 · ${selected.kind}`;
  menu.style.left=clamp(left+(width-263)/2,14,device.clientWidth-277)+'px';
  menu.style.top=(top+height+12)+'px';
  lift.value=.91;lift.velocity=1.8;lift.target=1;
  $('#branch-action').focus({preventScroll:true});caption(`已选中${selected.kind}：从这里分支，或留一个想法。`);
}
function closeSelection(restore=true){
  $('#selection-layer').hidden=true;page.inert=treeOpen;
  if(restore&&selectionAnchor?.isConnected)selectionAnchor.focus({preventScroll:true});
  selected=null;
  selectionPointerId=null;selectionDismissAfter=0;
}
$('#selection-scrim').addEventListener('click',()=>{if(performance.now()>selectionDismissAfter)closeSelection();});
$('#try-press').addEventListener('click',()=>{setTree(false);scroll.scrollTop=0;openSelection(content.querySelector('[data-block="garden"]')||content.querySelector('[data-block]'));});

function openSheet(title,html){
  sheetRestore=document.activeElement;
  $('#sheet-title').textContent=title;$('#sheet-body').innerHTML=html;$('#sheet-layer').hidden=false;page.inert=true;
  if(!reduced.matches)$('#sheet').animate([{transform:'translateY(80px)',opacity:.5},{transform:'translateY(0)',opacity:1}],{duration:260,easing:'cubic-bezier(.15,.8,.2,1)'});
  const first=$('#sheet-body').querySelector('input,textarea,button')||$('#sheet-close');
  first.focus({preventScroll:true});
}
function closeSheet(restore=true){
  if($('#sheet-layer').hidden)return;
  $('#sheet-layer').hidden=true;page.inert=treeOpen;
  if(restore){if(selectionAnchor?.isConnected)selectionAnchor.focus({preventScroll:true});else if(sheetRestore?.isConnected)sheetRestore.focus({preventScroll:true});}
}
$('#sheet-close').addEventListener('click',()=>closeSheet());$('#sheet-scrim').addEventListener('click',()=>closeSheet());
$('#branch-action').addEventListener('click',()=>{
  const source={...selected};closeSelection(false);
  openSheet('从这里，走向哪里？',`<div class="source-quote">${escape(source.text)}</div><form id="branch-form"><label for="branch-name">给这个念头起个名字</label><input id="branch-name" maxlength="36" autocomplete="off" placeholder="比如：如果换一种方式呢？" required><button class="primary-button" type="submit">${icon('branch')}创建分支</button><p class="sheet-note">来源会留在新页面，原来的思路也一直在。</p></form>`);
  $('#branch-form').addEventListener('submit',e=>{
    e.preventDefault();const title=$('#branch-name').value.trim();if(!title)return;
    const id=globalThis.crypto?.randomUUID?.()||`branch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
    state.nodes.push({id,parent:source.nodeId,title,summary:`从一${source.kind==='段落'?'段话':'块内容'}延伸的新思路`,source});
    closeSheet(false);selectNode(id);haptic();toast('新分支已长出来 · 来处也留住了');
  });
});
function commentKey(source){return `${source.nodeId}:${source.blockId}`;}
function showComments(source){
  const items=state.comments[commentKey(source)]||[];
  openSheet(items.length?'这里的想法':'留一个想法',`<div class="source-quote">${escape(source.text)}</div>${items.length?`<div class="comment-list">${items.map(x=>`<div class="comment-item"><small>你 · ${new Date(x.time).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}</small>${escape(x.text)}</div>`).join('')}</div>`:''}<form id="comment-form"><label for="comment-text">${items.length?'再补充一点':'这一刻，你想到了什么？'}</label><textarea id="comment-text" maxlength="1000" placeholder="也许，还可以…" required></textarea><button class="primary-button" type="submit">${icon('comment')}留下评论</button></form>`);
  $('#comment-form').addEventListener('submit',e=>{
    e.preventDefault();const text=$('#comment-text').value.trim();if(!text)return;
    (state.comments[commentKey(source)]??=[]).push({text,time:Date.now()});
    save();closeSheet(false);renderCommentBadges();haptic();toast('想法已留在这段内容旁');
    selectionAnchor?.focus({preventScroll:true});
  });
}
$('#comment-action').addEventListener('click',()=>{const source={...selected};closeSelection(false);showComments(source);});
function renderCommentBadges(){
  content.querySelectorAll('.comment-badge').forEach(el=>el.remove());
  content.querySelectorAll('[data-block]').forEach(b=>{
    const source={nodeId:state.current,blockId:b.dataset.block,kind:b.dataset.kind,text:b.innerText.trim()||b.querySelector('img')?.alt||'图片'};
    const count=state.comments[commentKey(source)]?.length||0;if(!count)return;
    const badge=document.createElement('button');badge.className='comment-badge';badge.setAttribute('aria-label',`查看 ${count} 条评论`);badge.innerHTML=icon('comment')+count;
    badge.addEventListener('click',()=>{selectionAnchor=b;showComments(source);});
    b.append(badge);
  });
}

$('#composer').addEventListener('submit',e=>{
  e.preventDefault();const value=$('#message-input').value.trim();if(!value)return;
  (state.messages[state.current]??=[]).push(value);$('#message-input').value='';
  renderPage();scroll.scrollTop=scroll.scrollHeight;state.scroll[state.current]=scroll.scrollTop;save();
  toast('已记录 · 原型使用示例回应');
});
$('#toggle-size').addEventListener('click',()=>{const wide=document.body.classList.toggle('expanded');$('#toggle-size span').textContent=wide?'手机画布':'展开画布';closeSelection();tree.resize();});
$('#reset').addEventListener('click',()=>{
  setTree(false);openSheet('重新走一遍？',`<p class="sheet-note">会清除这份原型里新增的分支、评论和示例消息，回到最初的五个页面。</p><div class="reset-actions"><button class="primary-button secondary-button" id="cancel-reset">保留</button><button class="primary-button" id="confirm-reset">重置原型</button></div>`);
  $('#cancel-reset').addEventListener('click',()=>closeSheet());$('#confirm-reset').addEventListener('click',()=>{state=fresh();save();closeSheet(false);renderPage();toast('回到最初的念头');});
});

document.addEventListener('keydown',e=>{
  const modal=!$('#sheet-layer').hidden?$('#sheet'):!$('#selection-layer').hidden?$('#selection-menu'):treeOpen?panel:null;
  if(e.key==='Escape'){
    if(!$('#sheet-layer').hidden)closeSheet();else if(!$('#selection-layer').hidden)closeSelection();else if(treeOpen)setTree(false);
    return;
  }
  if(e.key==='Tab'&&modal){
    const focusable=[...modal.querySelectorAll('button,input,textarea,[tabindex="0"]')].filter(el=>!el.disabled);
    const first=focusable[0],last=focusable.at(-1);
    if(e.shiftKey&&(document.activeElement===first||!modal.contains(document.activeElement))){e.preventDefault();last?.focus();}
    else if(!e.shiftKey&&(document.activeElement===last||!modal.contains(document.activeElement))){e.preventDefault();first?.focus();}
  }
  if(treeOpen&&e.target.tagName!=='INPUT'){
    if(e.key==='+'||e.key==='=')tree.zoom(1.2);if(e.key==='-')tree.zoom(.8);
    if(e.key==='0')tree.fit();
    const deltas={ArrowLeft:[40,0],ArrowRight:[-40,0],ArrowUp:[0,-40],ArrowDown:[0,40]};
    if(deltas[e.key]){e.preventDefault();tree.motion.tx+=deltas[e.key][0];tree.motion.ty+=deltas[e.key][1];}
  }
});
window.addEventListener('pagehide',()=>{state.scroll[state.current]=scroll.scrollTop;save();});
window.addEventListener('blur',()=>{cancelPress();if(pull)endPull(true);});
window.addEventListener('resize',()=>{if(!$('#selection-layer').hidden)closeSelection();});
function fitKeyboard(){if(innerWidth<=480)document.documentElement.style.setProperty('--visible-height',`${window.visualViewport?.height||innerHeight}px`);}
window.visualViewport?.addEventListener('resize',fitKeyboard);fitKeyboard();

function tick(time){
  const dt=Math.min((time-(tick.last||time))/1000,.032);tick.last=time;
  if(!pull&&!closePull){
    if(reduced.matches){reveal.value=reveal.target;reveal.velocity=0;}
    else{reveal.velocity+=((reveal.target-reveal.value)*300-reveal.velocity*30)*dt;reveal.value+=reveal.velocity*dt;}
  }
  const p=clamp(reveal.value,0,1.04),visible=p>.001||reveal.target===1||pull;
  panel.style.visibility=visible?'visible':'hidden';panel.style.opacity=clamp(p*1.6,0,1);
  panel.style.transform=reduced.matches?'none':`translate3d(${(1-p)*100}px,${(1-p)*-18}px,0) scale(${.72+.28*p})`;
  page.style.transform=reduced.matches?'none':`translate3d(${-7*p}px,${8*p}px,0) scale(${1-.045*p})`;
  page.style.opacity=String(1-.35*p);
  if(!visible&&tree.active)tree.setActive(false);
  if(!$('#selection-layer').hidden){
    if(reduced.matches)lift.value=1;
    else{lift.velocity+=((1-lift.value)*460-lift.velocity*24)*dt;lift.value+=lift.velocity*dt;}
    $('#selection-preview').style.transform=`scale(${lift.value})`;
    $('#selection-menu').style.transform=`translateY(${(1-lift.value)*50}px) scale(${lift.value})`;
  }
  tree.update(dt);requestAnimationFrame(tick);
}
renderPage();requestAnimationFrame(tick);
if(!tree.renderer)caption('此浏览器使用兼容渲染；手势仍可体验。');
if(!storageWorks)toast('本次体验暂未启用浏览器保存');
