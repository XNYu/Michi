import {useState} from 'react';
import {Button,Tooltip} from '@mantine/core';
import {Check} from 'lucide-react';
import type {BlockProps} from '../../types';
import {useBlockSend} from './useBlockSend';
import {L} from '../../../../../shared/i18n';

/** Buttons that each send their own prompt to the assistant, this block along as context. The whole group is locked for a moment after one click. */
export function ActionsBlock({block,ctx}:BlockProps<'actions'>){
 const {available,locked,fire}=useBlockSend(block,ctx),[sent,setSent]=useState<number|null>(null);
 const click=(i:number)=>{if(fire(block.buttons[i].prompt,block.buttons[i].label))setSent(i);};
 const group=<div className="desk-actions">{block.buttons.map((b,i)=>{
  const mine=locked&&sent===i;
  return <Button key={i} variant={mine?'light':'default'} size="sm" disabled={!available||locked} data-sent={mine||undefined}
   leftSection={mine?<Check size={14} strokeWidth={2} aria-hidden="true"/>:undefined} onClick={()=>click(i)}>{b.label}</Button>;
 })}</div>;
 // A disabled button gets no pointer events, so the tooltip hangs on the group around them.
 return available?group:<Tooltip label={L('助手暂时不可用','The assistant isn’t available right now')}>{group}</Tooltip>;
}
