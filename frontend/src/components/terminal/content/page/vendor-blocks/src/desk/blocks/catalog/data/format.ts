const number=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2});
/** Figures as people write them: grouped, and no more than two decimals. */
export const fmt=(n:number)=>number.format(n);
export const pct=(n:number)=>`${Math.round(n*100)}%`;
