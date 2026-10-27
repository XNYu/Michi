// Michi shim for agent-desk src/desk/blocks/types.ts: the mirrored renderers read Michi's block context
// (desk/page/blockTypes.ts), given to them by deskRenderers.tsx with the block already checked against the catalog.
import type {PageBlock,PageBlockMeta} from '../../../shared/desk-blocks';
import type {MichiBlockCtx} from '../../../../blockTypes';
export type BlockCtx=MichiBlockCtx;
/** `hid` is the id a block's own h2 carries, so the block can be labelled by it. */
export type BlockProps<K extends PageBlock['type']>={block:Extract<PageBlock,{type:K}>&PageBlockMeta;ctx:BlockCtx;hid:string};
