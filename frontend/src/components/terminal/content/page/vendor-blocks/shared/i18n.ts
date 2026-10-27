// Michi shim for agent-desk shared/i18n.ts: Michi's interface is English only, so every L() takes its English side.
export type Lang='zh'|'en';
export const LANGS:readonly Lang[]=['en'];
export const isLang=(value:unknown):value is Lang=>value==='zh'||value==='en';
export const lang=():Lang=>'en';
export function setLang(_value:Lang){}
export const L=<T>(_zh:T,en:T):T=>en;
export const locale=()=>'en-US';
export const plural=(n:number,one:string,many=`${one}s`)=>`${n.toLocaleString('en-US')} ${n===1?one:many}`;
