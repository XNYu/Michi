let odd=0;
/** FNV-1a over a value's JSON: what tells one code, set of props or list of fields from another. A value with no JSON (a cycle) is its own. */
export function signature(value:unknown):string{
  let text:string;try{text=JSON.stringify(value)??'';}catch{return `odd-${++odd}`;}
  let h=0x811c9dc5;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,0x01000193);}
  return `${(h>>>0).toString(36)}-${text.length}`;
}
