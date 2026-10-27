import { PAGE_COMPONENT_LIMITS, isComponentRecord } from './components';

export const COMPONENT_SANDBOX_IFRAME = 'allow-scripts' as const;
export const COMPONENT_SANDBOX_TIMEOUT_MS = 10_000;
export const COMPONENT_SANDBOX_CHANNEL_MIN = 24;
export const COMPONENT_SANDBOX_METHODS = ['read.host','read.database','write.rows','resize','navigate.page','ask.draft'] as const;
export type ComponentSandboxMethod = typeof COMPONENT_SANDBOX_METHODS[number];

/**
 * The palette and type a component frame receives as CSS variables on its
 * document, so a component follows the person's colours. The frame draws its
 * text in --term-fg and --ui-font; components use the rest with var().
 */
export const COMPONENT_SANDBOX_THEME_VARS = [
  '--term-bg','--term-surface','--term-alt','--term-alt2','--term-line','--term-line-s',
  '--term-fg','--term-mid','--term-muted','--term-faint',
  '--term-accent','--term-accent-f','--term-select','--term-select-f','--term-digest','--term-digest-f','--term-mauve','--term-mauve-f',
  '--term-danger','--term-danger-text','--ui-font','--font-mono',
] as const;
export type ComponentSandboxThemeVar = typeof COMPONENT_SANDBOX_THEME_VARS[number];
export type ComponentSandboxTheme = Partial<Record<ComponentSandboxThemeVar, string>>;

/** A colour or a font list: nothing that loads, and nothing that ends the declaration it is set in. */
export function isComponentSandboxThemeValue(value:unknown):value is string {
  return typeof value==='string'&&value.trim().length>0&&value.length<=300&&!/url\s*\(|image-set|expression|@import|[;{}<>\\]/i.test(value);
}

/** A theme from the host, or null when any entry is not a known variable with a safe value. */
export function parseComponentSandboxTheme(value:unknown):ComponentSandboxTheme|null {
  if(!isComponentRecord(value))return null;
  const known=COMPONENT_SANDBOX_THEME_VARS as readonly string[];
  return Object.entries(value).every(([key,v])=>known.includes(key)&&isComponentSandboxThemeValue(v))?value as ComponentSandboxTheme:null;
}

export type ComponentSandboxMessage =
  | { type:'michi-component:load'; channel:string; code:string; props:Record<string,unknown>; data:unknown; theme?:ComponentSandboxTheme }
  | { type:'michi-component:update'; channel:string; props:Record<string,unknown>; data:unknown }
  | { type:'michi-component:theme'; channel:string; theme:ComponentSandboxTheme }
  | { type:'michi-component:rendered'; channel:string }
  | { type:'michi-component:freeze'; channel:string }
  | { type:'michi-component:call'; channel:string; id:number; method:ComponentSandboxMethod; args:unknown[] }
  | { type:'michi-component:result'; channel:string; id:number; ok:boolean; value?:unknown; error?:string }
  | { type:'michi-component:error'; channel:string; message:string };

function bytes(value:unknown):number|null { try{return new TextEncoder().encode(JSON.stringify(value)).length;}catch{return null;} }
function bounded(value:unknown,max=PAGE_COMPONENT_LIMITS.propsBytes,depth=0):boolean {
  if(depth>20)return false;
  if(value===null||typeof value==='string'||typeof value==='boolean')return typeof value!=='string'||[...value].length<=PAGE_COMPONENT_LIMITS.propsBytes;
  if(typeof value==='number')return Number.isFinite(value);
  if(Array.isArray(value))return value.length<=2_000&&value.every(x=>bounded(x,max,depth+1));
  return isComponentRecord(value)&&Object.keys(value).length<=PAGE_COMPONENT_LIMITS.schemaProperties&&Object.entries(value).every(([k,v])=>k.length<=200&&bounded(v,max,depth+1))&&(bytes(value)??Infinity)<=max;
}
const exact=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).every(k=>keys.includes(k));

/** Validate untrusted postMessage payload shape/size. Caller still checks source Window and channel binding. */
export function parseComponentSandboxMessage(value:unknown):ComponentSandboxMessage|null {
  if(!isComponentRecord(value)||typeof value.type!=='string'||typeof value.channel!=='string'||value.channel.length<COMPONENT_SANDBOX_CHANNEL_MIN||value.channel.length>128)return null;
  if((value.type==='michi-component:rendered'||value.type==='michi-component:freeze')&&exact(value,['type','channel']))return value as unknown as ComponentSandboxMessage;
  if(value.type==='michi-component:load'&&exact(value,['type','channel','code','props','data','theme'])&&typeof value.code==='string'&&new TextEncoder().encode(value.code).length<=PAGE_COMPONENT_LIMITS.codeBytes&&isComponentRecord(value.props)&&bounded(value.props)&&bounded(value.data)&&(value.theme===undefined||parseComponentSandboxTheme(value.theme)!==null))return value as unknown as ComponentSandboxMessage;
  if(value.type==='michi-component:update'&&exact(value,['type','channel','props','data'])&&isComponentRecord(value.props)&&bounded(value.props)&&bounded(value.data))return value as unknown as ComponentSandboxMessage;
  if(value.type==='michi-component:theme'&&exact(value,['type','channel','theme'])&&parseComponentSandboxTheme(value.theme)!==null)return value as unknown as ComponentSandboxMessage;
  if(value.type==='michi-component:call'&&exact(value,['type','channel','id','method','args'])&&Number.isSafeInteger(value.id)&&(value.id as number)>0&&COMPONENT_SANDBOX_METHODS.includes(value.method as ComponentSandboxMethod)&&Array.isArray(value.args)&&value.args.length<=20&&(bytes(value.args)??Infinity)<=64_000)return value as unknown as ComponentSandboxMessage;
  if(value.type==='michi-component:result'&&exact(value,['type','channel','id','ok','value','error'])&&Number.isSafeInteger(value.id)&&(value.id as number)>0&&typeof value.ok==='boolean'&&(value.error===undefined||typeof value.error==='string'&&value.error.length<=2_000)&&(value.value===undefined||bounded(value.value)))return value as unknown as ComponentSandboxMessage;
  if(value.type==='michi-component:error'&&exact(value,['type','channel','message'])&&typeof value.message==='string'&&value.message.length<=2_000)return value as unknown as ComponentSandboxMessage;
  return null;
}
