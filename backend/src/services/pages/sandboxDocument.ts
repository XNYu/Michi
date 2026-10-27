import { COMPONENT_SANDBOX_THEME_VARS } from 'michi-shared';

/**
 * The frame's own look: text in the person's palette and UI font, and
 * controls and tables drawn like Michi's, before a component styles anything.
 * Each colour falls back to the system's when the host sends no theme.
 */
const COMPONENT_SANDBOX_STYLE = [
  'html,body,#root{margin:0;min-height:100%;width:100%}',
  'body{overflow:auto;background:transparent;color:var(--term-fg,CanvasText);font:13px/1.5 var(--ui-font,system-ui,sans-serif);-webkit-font-smoothing:antialiased}',
  'button,input,select,textarea{font:inherit;color:inherit}',
  'button{padding:4px 10px;border:1px solid var(--term-line-s,ButtonBorder);border-radius:5px;background:var(--term-alt,ButtonFace);cursor:pointer}',
  'button:hover{background:var(--term-alt2,ButtonFace)}button:disabled{opacity:.55;cursor:default}',
  'input,select,textarea{padding:4px 8px;border:1px solid var(--term-line-s,ButtonBorder);border-radius:5px;background:var(--term-bg,Field)}',
  'input,progress,meter{accent-color:var(--term-accent,auto)}:focus-visible{outline:2px solid var(--term-accent,Highlight);outline-offset:1px}',
  'table{border-collapse:collapse}th,td{padding:6px 8px;border-bottom:1px solid var(--term-line,GrayText);text-align:left}th{color:var(--term-muted,inherit);font-weight:500}',
  'small{color:var(--term-muted,inherit)}hr{border:0;border-top:1px solid var(--term-line,GrayText)}',
].join('');

/** Fixed document for opaque-origin custom component frames. Component code is only ever posted into this isolated document. */
export const COMPONENT_SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  'worker-src blob:',
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'sandbox allow-scripts',
].join('; ');

export const COMPONENT_SANDBOX_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${COMPONENT_SANDBOX_CSP}">
<style>${COMPONENT_SANDBOX_STYLE}</style></head>
<body><div id="root"></div><script>
(() => {
  'use strict';
  const root = document.getElementById('root');
  const allowedTags = new Set(['div','span','p','h1','h2','h3','h4','strong','em','small','ul','ol','li','table','thead','tbody','tr','th','td','section','article','main','header','footer','label','button','input','textarea','select','option','progress','meter','br','hr']);
  const allowedAttrs = new Set(['title','role','aria-label','aria-live','type','value','placeholder','min','max','step','checked','disabled','selected','colspan','rowspan','class','id']);
  const themeVars = new Set(${JSON.stringify(COMPONENT_SANDBOX_THEME_VARS)});
  const applyTheme = theme => {
    if (!theme || typeof theme !== 'object' || Array.isArray(theme)) return;
    // A whole theme each time: a variable it leaves out, or whose value could load something, falls back to the frame's default.
    for (const key of themeVars) {
      const value = Object.prototype.hasOwnProperty.call(theme, key) ? theme[key] : undefined;
      if (typeof value === 'string' && value.trim() && value.length <= 300 && !/url\\s*\\(|image-set|expression|@import|[;{}<>\\\\]/i.test(value)) document.documentElement.style.setProperty(key,value);
      else document.documentElement.style.removeProperty(key);
    }
  };
  let channel = null;
  let worker = null;
  let workerUrl = null;
  let apiSequence = 0;
  const apiPending = new Map();
  const workerSource = (code) => [
    '"use strict";',
    'const componentCode=' + JSON.stringify(code) + ';',
    'const allowedTags=new Set(' + JSON.stringify(Array.from(allowedTags)) + ');',
    'const nodes=new Map();let nextNode=0;let apiSequence=0;const apiPending=new Map();let currentProps={};let currentData={};let root;',
    'const text=v=>String(v==null?"":v).slice(0,20000);',
    'const safeEvent=new Set(["click","input","change"]);',
    'let renderQueued=false;const scheduleRender=()=>{if(renderQueued)return;renderQueued=true;queueMicrotask(()=>{if(renderQueued)render()})};',
    'class VNode{constructor(tag){this.tag=tag;this.nodeId=++nextNode;this.text="";this.attrs={};this.styles={};this.children=[];this.handlers={}}',
    'appendChild(node){if(!(node instanceof VNode))throw new TypeError("Expected a virtual node");this.children.push(node);scheduleRender();return node}',
    'append(...items){for(const item of items)this.appendChild(item instanceof VNode?item:new VNode("#text").setText(item))}',
    'removeChild(node){const i=this.children.indexOf(node);if(i>=0){this.children.splice(i,1);scheduleRender()}return node}',
    'replaceChildren(...items){this.children=[];this.text="";this.append(...items);scheduleRender()}',
    'setAttribute(name,value){if(!/^(title|role|aria-[a-z-]+|type|value|placeholder|min|max|step|checked|disabled|selected|colspan|rowspan|class|id)$/.test(name))return;this.attrs[name]=text(value);scheduleRender()}',
    'addEventListener(type,fn){if(!safeEvent.has(type)||typeof fn!=="function")return;(this.handlers[type]||(this.handlers[type]=[])).push(fn)}',
    'setText(value){this.text=text(value);scheduleRender();return this}',
    'get textContent(){return this.text+this.children.map(x=>x.textContent).join("")}',
    'set textContent(value){this.text=text(value);this.children=[];scheduleRender()}',
    'get className(){return this.attrs.class||""}set className(value){this.attrs.class=text(value);scheduleRender()}',
    'get id(){return this.attrs.id||""}set id(value){this.attrs.id=text(value);scheduleRender()}',
    'get style(){return this._style||(this._style=new Proxy({}, {set:(_t,k,v)=>{if(/^[a-zA-Z][a-zA-Z0-9-]{0,50}$/.test(String(k))&&!/url\\\\s*\\\\(|expression|@import/i.test(String(v))&&String(v).length<=500){this.styles[String(k)]=String(v);scheduleRender()}return true},get:(_t,k)=>this.styles[String(k)]}))}',
    'get dataset(){return this._dataset||(this._dataset=new Proxy({}, {set:(_t,k,v)=>{if(/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(String(k))){this.attrs["data-"+String(k).replace(/[A-Z]/g,m=>"-"+m.toLowerCase())]=text(v);scheduleRender()}return true},get:(_t,k)=>this.attrs["data-"+String(k).replace(/[A-Z]/g,m=>"-"+m.toLowerCase())]}))}',
    'snapshot(depth=0,live=new Map(),parent=null){if(depth>20||live.size>=2000)throw new Error("Component render is too large");this.parent=parent;live.set(this.nodeId,this);const tree={id:this.nodeId,tag:this.tag,text:this.text,attrs:this.attrs,styles:this.styles,events:Object.keys(this.handlers),children:this.children.map(x=>x.snapshot(depth+1,live,this))};if(depth===0){nodes.clear();for(const [id,node] of live)nodes.set(id,node)}return tree}}',
    'const document={createElement:tag=>{if(typeof tag!=="string"||!allowedTags.has(tag.toLowerCase()))throw new Error("Unsupported element");return new VNode(tag.toLowerCase())},createTextNode:value=>new VNode("#text").setText(value)};',
    'const call=(method,...args)=>new Promise((resolve,reject)=>{const id=++apiSequence;apiPending.set(id,{resolve,reject});postMessage({type:"call",id,method,args});setTimeout(()=>{const p=apiPending.get(id);if(p){apiPending.delete(id);p.reject(new Error("Request timed out"))}},10000)});',
    'const render=()=>{renderQueued=false;try{const tree=root.snapshot();if(new TextEncoder().encode(JSON.stringify(tree)).byteLength>64000)throw new Error("Component render is too large");postMessage({type:"render",tree})}catch(e){postMessage({type:"error",message:String(e&&e.message||"Render failed").slice(0,2000)})}};',
    'const freeze=v=>{if(v&&typeof v==="object"){Object.freeze(v);for(const x of Object.values(v))freeze(x)}return v};',
    'const runUpdate=(props,data)=>{currentProps=freeze(props||{});currentData=freeze(data);if(typeof globalThis.onMichiComponentUpdate==="function")globalThis.onMichiComponentUpdate(currentProps,currentData);render()};',
    'root=new VNode("#root");const start=new Function("root","props","data","call","document",componentCode);',
    'for(const key of ["Worker","SharedWorker","importScripts","fetch","XMLHttpRequest","WebSocket","EventSource","BroadcastChannel","WebTransport","RTCPeerConnection","location"]){try{Object.defineProperty(globalThis,key,{value:undefined,writable:false,configurable:false})}catch(_){}}',
    'onmessage=event=>{const m=event.data||{};if(m.type==="load"){try{currentProps=freeze(m.props||{});currentData=freeze(m.data);start(root,currentProps,currentData,call,document);render()}catch(e){postMessage({type:"error",message:String(e&&e.message||"Component failed").slice(0,2000)})}return}',
    'if(m.type==="update"){try{runUpdate(m.props,m.data)}catch(e){postMessage({type:"error",message:String(e&&e.message||"Update failed").slice(0,2000)})}return}',
    'if(m.type==="result"){const p=apiPending.get(m.id);if(p){apiPending.delete(m.id);m.ok?p.resolve(m.value):p.reject(new Error(String(m.error||"Request failed")));setTimeout(render,0)}return}',
    'if(m.type==="event"&&safeEvent.has(m.event)){const node=nodes.get(m.nodeId);if(!node)return;if(m.value!==undefined)node.attrs.value=text(m.value);if(m.checked!==undefined)node.attrs.checked=String(!!m.checked);let stopped=false;const target=at=>({value:at.attrs.value||"",checked:at.attrs.checked==="true",textContent:at.textContent});const e={type:m.event,target:target(node),currentTarget:null,preventDefault(){},stopPropagation(){stopped=true}};for(let at=node;at;at=at.parent){e.currentTarget=target(at);for(const fn of at.handlers[m.event]||[])try{fn(e)}catch(_){};if(stopped)break}render()}};'
  ].join('\\n');
  const sendError = message => parent.postMessage({type:'michi-component:error',channel,message:String(message||'Component failed').slice(0,2000)}, '*');
  const applyTree = tree => {
    let encoded;
    try { encoded = JSON.stringify(tree); } catch (_) { throw new Error('Invalid component render tree'); }
    if (new TextEncoder().encode(encoded).byteLength > 64000) throw new Error('Component render is too large');
    let count = 0;
    const validate = (node, depth = 0, rootNode = false) => {
      if (!node || typeof node !== 'object' || Array.isArray(node) || ++count > 2000 || depth > 20) throw new Error('Invalid component render tree');
      if (typeof node.tag !== 'string' || (rootNode ? node.tag !== '#root' : node.tag === '#root' || node.tag !== '#text' && !allowedTags.has(node.tag))) throw new Error('Invalid component render tree');
      if (typeof node.text !== 'string' || node.text.length > 20000 || !Number.isSafeInteger(node.id) || node.id < 1) throw new Error('Invalid component render tree');
      if (!node.attrs || typeof node.attrs !== 'object' || Array.isArray(node.attrs) || Object.keys(node.attrs).length > 64) throw new Error('Invalid component render tree');
      if (!node.styles || typeof node.styles !== 'object' || Array.isArray(node.styles) || Object.keys(node.styles).length > 64) throw new Error('Invalid component render tree');
      if (!Array.isArray(node.children) || node.children.length > 2000) throw new Error('Invalid component render tree');
      for (const value of Object.values(node.attrs)) if (typeof value !== 'string' || value.length > 1000) throw new Error('Invalid component render tree');
      for (const value of Object.values(node.styles)) if (typeof value !== 'string' || value.length > 500) throw new Error('Invalid component render tree');
      for (const child of node.children) validate(child, depth + 1);
    };
    validate(tree, 0, true);
    const nextRoot = document.createElement('div');
    const bind = node => {
      if (!node || typeof node !== 'object' || node.tag !== '#root' && node.tag !== '#text' && !allowedTags.has(node.tag)) throw new Error('Invalid component render tree');
      if (node.tag === '#text') return document.createTextNode(String(node.text||''));
      const element = node.tag === '#root' ? nextRoot : document.createElement(node.tag);
      if (node.tag !== '#root') {
        element.setAttribute('data-michi-node-id', String(node.id));
        for (const [key,value] of Object.entries(node.attrs||{})) {
          if (allowedAttrs.has(key) && typeof value === 'string') element.setAttribute(key,value);
          else if (/^data-[a-z0-9-]{1,50}$/.test(key) && typeof value === 'string') element.setAttribute(key,value);
        }
        for (const [key,value] of Object.entries(node.styles||{})) {
          if (/^[a-zA-Z][a-zA-Z0-9-]{0,50}$/.test(key) && typeof value === 'string' && !/url\\s*\\(|expression|@import/i.test(value)) element.style.setProperty(key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()),value.slice(0,500));
        }
      }
      if (node.text) element.appendChild(document.createTextNode(String(node.text).slice(0,20000)));
      for (const child of node.children) element.appendChild(bind(child));
      return element;
    };
    bind(tree);
    root.replaceChildren(...nextRoot.childNodes);
  };
  const startWorker = message => {
    if (worker) worker.terminate(); if (workerUrl) URL.revokeObjectURL(workerUrl);
    channel = message.channel;
    workerUrl = URL.createObjectURL(new Blob([workerSource(message.code)], {type:'text/javascript'}));
    worker = new Worker(workerUrl);
    worker.onerror = event => { event.preventDefault(); sendError('Component worker failed: ' + String(event.message||'unknown error').slice(0,300) + ' (' + (Number(event.lineno)||0) + ':' + (Number(event.colno)||0) + ')'); worker?.terminate(); worker = null; };
    worker.onmessage = event => {
      const result = event.data||{};
      if (result.type === 'render') { try { applyTree(result.tree); if (root.hasChildNodes()) parent.postMessage({type:'michi-component:rendered',channel}, '*'); } catch (error) { sendError(error instanceof Error ? error.message : 'Invalid render tree'); worker?.terminate(); worker = null; } }
      else if (result.type === 'call' && Number.isSafeInteger(result.id) && typeof result.method === 'string' && Array.isArray(result.args)) parent.postMessage({type:'michi-component:call',channel,id:result.id,method:result.method,args:result.args}, '*');
      else if (result.type === 'error') sendError(result.message);
    };
    worker.postMessage({type:'load',props:message.props,data:message.data});
  };
  root.addEventListener('click', event => { const node=event.target.closest('[data-michi-node-id]'); if(node&&worker)worker.postMessage({type:'event',event:'click',nodeId:Number(node.dataset.michiNodeId)}); });
  for (const type of ['input','change']) root.addEventListener(type, event => { const node=event.target.closest('[data-michi-node-id]'); if(node&&worker)worker.postMessage({type:'event',event:type,nodeId:Number(node.dataset.michiNodeId),value:event.target.value,checked:event.target.checked}); });
  addEventListener('message', event => {
    if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
    const message = event.data;
    if (message.type === 'michi-component:wrapper-init' && !channel && typeof message.channel === 'string' && message.channel.length >= 24 && message.channel.length <= 128) {
      channel = message.channel;
      parent.postMessage({type:'michi-component:wrapper-ready',channel}, '*');
      return;
    }
    if (!channel || message.channel !== channel) return;
    if (message.type === 'michi-component:freeze') { worker?.terminate(); worker = null; if (workerUrl) URL.revokeObjectURL(workerUrl); workerUrl = null; return; }
    if (message.type === 'michi-component:theme') { applyTheme(message.theme); return; }
    if (message.type === 'michi-component:load' && typeof message.code === 'string' && new TextEncoder().encode(message.code).byteLength <= 200000 && message.props && typeof message.props === 'object' && !Array.isArray(message.props) && 'data' in message) { applyTheme(message.theme); startWorker(message); return; }
    if (!worker) return;
    if (message.type === 'michi-component:update') worker.postMessage({type:'update',props:message.props,data:message.data});
    if (message.type === 'michi-component:result' && Number.isSafeInteger(message.id)) worker.postMessage({type:'result',id:message.id,ok:message.ok,value:message.value,error:message.error});
  });
})();
</script></body></html>`;

/** Compatibility exports: the legacy wrapper endpoint now serves the isolated runner document. */
export const COMPONENT_SANDBOX_WRAPPER_CSP = COMPONENT_SANDBOX_CSP;
export const COMPONENT_SANDBOX_WRAPPER_HTML = COMPONENT_SANDBOX_HTML;

export function componentSandboxWrapper(pathname: string): { html: string; csp: string } {
  if (!/^\/[A-Za-z0-9/_-]+\/component-sandbox-wrapper$/.test(pathname)) throw new Error('Invalid component sandbox wrapper path');
  return {
    html: COMPONENT_SANDBOX_WRAPPER_HTML,
    csp: COMPONENT_SANDBOX_WRAPPER_CSP,
  };
}
