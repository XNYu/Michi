import {dayLabel,parseDay} from '../../../db/db-ui';
import {L,locale,plural} from '../../../../../shared/i18n';

const DAY=/^\d{4}-\d{2}-\d{2}$/,ISO=/^\d{4}-\d{2}-\d{2}/;
const pad=(n:number)=>String(n).padStart(2,'0');
/** What an agent writes for "when" is free text ('Oct 2', 'Q4') as often as a date; only an ISO one is read, the rest is shown as written. */
const dateOf=(s:string)=>{const t=s.trim();return ISO.test(t)?parseDay(t.replace(' ','T')):null;};
/** 「10月17日」, or 「10月17日 14:30」 when it has a time; another year's day says its year. */
export function whenText(s:string):string{
  const d=dateOf(s);if(!d)return s;
  const t=s.trim(),day=L(dayLabel(DAY.test(t)?t:t.replace(' ','T')),d.toLocaleDateString('en-US',{month:'short',day:'numeric',...d.getFullYear()===new Date().getFullYear()?{}:{year:'numeric'}}));
  return DAY.test(t)?day:`${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 「10月20日 周二」 for a day or date-time. */
export function dayText(s:string):string{const d=dateOf(s);return d?L(`${whenText(s)} 周${'日一二三四五六'[d.getDay()]}`,`${d.toLocaleDateString('en-US',{weekday:'long'})}, ${whenText(s)}`):s;}

/** The moment a countdown aims at: a bare day is the start of that day on this device, a date-time its own instant. NaN when unreadable. */
export const instantOf=(s:string)=>parseDay(s.trim().replace(' ','T'))?.getTime()??NaN;
/** 「还有 3 天 4 小时」; the two largest units, and under an hour just minutes. Zero or less is 「已到」. */
export function leftText(ms:number):string{
  if(ms<=0)return L('已到','Time’s up');
  const m=Math.floor(ms/60_000),d=Math.floor(m/1440),h=Math.floor(m%1440/60),min=m%60;
  if(d>0)return h>0?L(`还有 ${d} 天 ${h} 小时`,`${plural(d,'day')} ${plural(h,'hour')} left`):L(`还有 ${d} 天`,`${plural(d,'day')} left`);
  if(h>0)return min>0?L(`还有 ${h} 小时 ${min} 分钟`,`${plural(h,'hour')} ${plural(min,'minute')} left`):L(`还有 ${h} 小时`,`${plural(h,'hour')} left`);
  return m>0?L(`还有 ${m} 分钟`,`${plural(m,'minute')} left`):L('还有不到 1 分钟','Less than a minute left');
}

export type Face={time:string;date:string;offset:string};
/** Draws a zone's face at a time, or null when the device does not know the zone name. The offset is a nicety: a device that cannot print it still shows the clock. */
export function faceOf(tz:string):((now:number)=>Face)|null{
  let core:{time:Intl.DateTimeFormat;date:Intl.DateTimeFormat};
  try{core={time:new Intl.DateTimeFormat(locale(),{timeZone:tz,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),
    date:new Intl.DateTimeFormat(locale(),{timeZone:tz,month:'long',day:'numeric',weekday:'short'})};}catch{return null;}
  const {time,date}=core;let off:Intl.DateTimeFormat|null=null;
  try{off=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'shortOffset'});}catch{/* older engines */}
  return now=>({time:time.format(now),date:date.format(now),offset:off?.formatToParts(now).find(p=>p.type==='timeZoneName')?.value??''});
}
