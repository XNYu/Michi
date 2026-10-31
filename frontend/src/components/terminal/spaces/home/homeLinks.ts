// What the homes use from Spaces source navigation, the new-chat sheet and the
// Space conversation cards, in one place so tests can stub them together.
import { openConversationFromSpaces, openExactSourcePopover, openSourcePopover } from '../../source';

const SOURCE_NAV = { openExactSourcePopover, openSourcePopover, openConversationFromSpaces };
export function useSpacesSourceNav() { return SOURCE_NAV; }

export { default as NativePageDocument } from '../NativePageDocument';
export { blockItemTarget, useMetaChatTargeting, type MetaChatBlockTarget } from '../metaChat/SpacesMetaChat';
export { openNewChatSheet, type SpaceConversationScope } from '../../../../state/spaceConversations/store';
export { useSpaceConversationBadges } from '../../../../state/spaceConversations/watcher';
export { NewChatSheetSlot, PageProgressCards, SpaceProgressCardList } from '../conversation/SpaceConversationSlot';
