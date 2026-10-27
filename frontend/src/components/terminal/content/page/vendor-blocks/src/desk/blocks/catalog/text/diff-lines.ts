export type DiffLine={kind:'same'|'add'|'del';text:string};
/** Past this many cells the middle is shown as all removed then all added rather than held in memory as a table. */
const CELLS=2_000_000;
const lines=(s:string)=>s===''?[]:s.split(/\r?\n/);
/** Line by line, before against after: the common head and tail are kept as they are, the rest matched by longest common subsequence,
 * a removal before the addition that replaces it. */
export function diffLines(before:string,after:string):DiffLine[]{
 const a=lines(before),b=lines(after);
 let head=0;while(head<a.length&&head<b.length&&a[head]===b[head])head++;
 let tail=0;while(tail<a.length-head&&tail<b.length-head&&a[a.length-1-tail]===b[b.length-1-tail])tail++;
 const x=a.slice(head,a.length-tail),y=b.slice(head,b.length-tail),n=x.length,m=y.length,mid:DiffLine[]=[];
 const del=(text:string)=>mid.push({kind:'del',text}),add=(text:string)=>mid.push({kind:'add',text});
 if(n*m>CELLS){x.forEach(del);y.forEach(add);}
 else{
  // t[i][j]: the longest common run of x from i and y from j.
  const w=m+1,t=new Uint32Array((n+1)*w);
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)t[i*w+j]=x[i]===y[j]?t[(i+1)*w+j+1]+1:Math.max(t[(i+1)*w+j],t[i*w+j+1]);
  let i=0,j=0;
  while(i<n&&j<m){if(x[i]===y[j]){mid.push({kind:'same',text:x[i]});i++;j++;}else if(t[(i+1)*w+j]>=t[i*w+j+1])del(x[i++]);else add(y[j++]);}
  while(i<n)del(x[i++]);while(j<m)add(y[j++]);
 }
 const same=(text:string):DiffLine=>({kind:'same',text});
 return [...a.slice(0,head).map(same),...mid,...a.slice(a.length-tail).map(same)];
}
