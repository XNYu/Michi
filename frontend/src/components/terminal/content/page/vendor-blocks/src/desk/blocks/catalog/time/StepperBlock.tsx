import {Stepper} from '@mantine/core';
import type {BlockProps} from '../../types';
import {Title} from './Title';
import './time.css';

/** Read-only: no step can be clicked. Past the last step every step is done (the schema clamps `current` to the step count). */
export function StepperBlock({block,hid}:BlockProps<'stepper'>){
  return <>
    <Title id={hid} text={block.title}/>
    <Stepper active={block.current} size="sm" orientation={block.steps.length>5?'vertical':'horizontal'} allowNextStepsSelect={false}
      classNames={{root:'desk-time-stepper',step:'desk-time-step',stepLabel:'desk-time-step-label'}}>
      {block.steps.map((s,i)=><Stepper.Step key={i} label={s.label} description={s.text} aria-current={i===block.current?'step':undefined}/>)}
    </Stepper>
  </>;
}
