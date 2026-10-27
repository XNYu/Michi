import {useState,type FormEvent} from 'react';
import {Button,Checkbox,NumberInput,Select,TextInput,Tooltip} from '@mantine/core';
import {DatePickerInput,DatesProvider} from '@mantine/dates';
import 'dayjs/locale/zh-cn';
import {signature} from '../../../hash';
import type {BlockProps} from '../../types';
import {useBlockSend} from './useBlockSend';
import {L} from '../../../../../shared/i18n';

type Field=BlockProps<'form'>['block']['fields'][number];
/** What a control holds while it is being filled in: a number box keeps what was typed until it is read. */
type Raw=string|number|boolean|null;
type Answer=string|number|boolean|null;
const blank=(f:Field):Raw=>f.type==='checkbox'?false:f.type==='select'||f.type==='date'?null:'';
/** What goes out for a field: text trimmed, a number as a number (empty or half-typed is null), a date as YYYY-MM-DD, a select as the option. */
function answerOf(f:Field,raw:Raw):Answer{
 switch(f.type){
  case 'text':return typeof raw==='string'?raw.trim():'';
  case 'number':{const n=typeof raw==='number'?raw:typeof raw==='string'&&raw.trim()?Number(raw):NaN;return Number.isFinite(n)?n:null;}
  case 'checkbox':return raw===true;
  default:return typeof raw==='string'&&raw?raw:null;
 }
}
// Zero and unchecked-but-optional are answers; only nothing at all, or a required box left unticked, is not.
const missing=(f:Field,a:Answer)=>!!f.required&&(f.type==='checkbox'?a!==true:a===null||a==='');

/** A form of Mantine controls: submitting sends `prompt` and the values (by field key) to the assistant. A required field left empty stops the send and says so
 * beside it. After a send the values stay and the button says 「已发送」 for a moment. Values are kept by place, so a form rewritten with
 * other fields under the same id starts again empty. */
export const FormBlock=(p:BlockProps<'form'>)=><Form key={signature(p.block.fields)} {...p}/>;
function Form({block,ctx,hid}:BlockProps<'form'>){
 const {title,fields,prompt,submitLabel}=block,{available,locked,fire,sentLabel}=useBlockSend(block,ctx);
 const [raw,setRaw]=useState<Raw[]>(()=>fields.map(blank)),[bad,setBad]=useState<number[]>([]);
 const set=(i:number,v:Raw)=>{setRaw(r=>r.map((x,j)=>j===i?v:x));setBad(b=>b.includes(i)?b.filter(j=>j!==i):b);};
 const submit=(event:FormEvent)=>{
  event.preventDefault();
  const answers=fields.map((f,i)=>answerOf(f,raw[i])),empty=fields.flatMap((f,i)=>missing(f,answers[i])?[i]:[]);
  setBad(empty);
  if(empty.length)return;
  // Keys are the model's words: build the object by entries, so a key like __proto__ is a key and nothing more.
  fire(`${prompt}\n\n${JSON.stringify(Object.fromEntries(fields.map((f,i)=>[f.key,answers[i]])))}`,title);
 };
 const control=(f:Field,i:number)=>{
  const common={label:f.label,required:f.required,error:bad.includes(i)?(f.type==='checkbox'?L('请勾选','Check this'):L('请填写','Fill this in')):undefined};
  switch(f.type){
   case 'number':return <NumberInput {...common} value={raw[i] as string|number} onChange={v=>set(i,v)} thousandSeparator="," hideControls/>;
   case 'select':return <Select {...common} data={'options' in f?f.options:[]} value={raw[i] as string|null} onChange={v=>set(i,v)} placeholder={L('请选择','Choose')} allowDeselect={!f.required}/>;
   case 'date':return <DatePickerInput {...common} value={raw[i] as string|null} onChange={v=>set(i,v)} valueFormat={L('YYYY年M月D日','MMM D, YYYY')} placeholder={L('选择日期','Pick a date')} clearable={!f.required}/>;
   case 'checkbox':return <Checkbox {...common} checked={raw[i]===true} onChange={event=>set(i,event.currentTarget.checked)}/>;
   default:return <TextInput {...common} value={raw[i] as string} onChange={event=>set(i,event.currentTarget.value)}/>;
  }
 };
 const button=<Button type="submit" size="sm" disabled={!available||locked}>{locked?sentLabel:submitLabel??L('提交','Submit')}</Button>;
 return <>
  <h2 id={hid} className="desk-block-title">{title}</h2>
  <DatesProvider settings={{locale:L('zh-cn','en'),firstDayOfWeek:1}}>
   <form className="desk-form" noValidate aria-labelledby={hid} onSubmit={submit}>
    {fields.map((f,i)=><div key={i} className="desk-form-field">{control(f,i)}</div>)}
    <div className="desk-form-foot" aria-live="polite">{available?button:<Tooltip label={L('助手暂时不可用','The assistant isn’t available right now')}><span>{button}</span></Tooltip>}</div>
   </form>
  </DatesProvider>
 </>;
}
