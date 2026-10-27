import {Suspense,lazy} from 'react';
import type {BlockProps} from '../../types';
import {L} from '../../../../../shared/i18n';

// recharts and Mantine's charts are a chunk of their own, fetched when the first chart is drawn.
const Chart=lazy(()=>import('./kinds').then(m=>({default:m.Chart})));

/** Draws its own h2 (BlockView.headed), so the block is named before the chart has loaded. */
export function ChartBlock({block,hid}:BlockProps<'chart'>){
  return <>
    <h2 id={hid} className="desk-block-title">{block.title}</h2>
    <Suspense fallback={<div className="desk-chart-box" data-kind={block.kind}><p className="desk-quiet">{L('图表加载中…','Loading chart…')}</p></div>}><Chart block={block}/></Suspense>
  </>;
}
