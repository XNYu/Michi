import type {PageBlock} from '../../../../../shared/desk-blocks';
export {TimelineBlock,MilestonesBlock} from './TimelineBlock';
export {StepperBlock} from './StepperBlock';
export {AgendaBlock} from './AgendaBlock';
export {CalendarBlock} from './CalendarBlock';
export {GanttBlock} from './GanttBlock';
export {CountdownBlock} from './CountdownBlock';
export {ClocksBlock} from './ClocksBlock';

/** Time blocks that draw their own h2 (BlockView's `headed`): a countdown always has a title, the rest when they were given one; clocks have none. */
export const timeHeaded=(b:PageBlock)=>b.type==='countdown'||(b.type==='timeline'||b.type==='milestones'||b.type==='stepper'||b.type==='agenda'||b.type==='calendar'||b.type==='gantt')&&!!b.title;
