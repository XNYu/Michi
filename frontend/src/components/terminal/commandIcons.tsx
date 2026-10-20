import React from 'react';
import type { CommandIcon } from '../../state/commands';
import {
  AgentIcon,
  ArchiveIcon,
  BranchesIcon,
  ChatIcon,
  DigestIcon,
  ExportIcon,
  DeskIcon,
  HomeIcon,
  MapIcon,
  PlusIcon,
  SettingsIcon,
  ShieldIcon,
  ShieldOffIcon,
  StopIcon,
  ThreadIcon,
  TrashIcon,
  UserIcon,
  WeaveIcon,
  WorkspacesIcon,
} from './icons';

const COMMAND_ICONS: Record<CommandIcon, (props: { size?: number }) => React.ReactElement> = {
  agent: AgentIcon,
  home: HomeIcon,
  desk: DeskIcon,
  branches: BranchesIcon,
  map: MapIcon,
  digest: DigestIcon,
  workspace: WorkspacesIcon,
  trash: TrashIcon,
  archive: ArchiveIcon,
  settings: SettingsIcon,
  profile: UserIcon,
  plus: PlusIcon,
  shield: ShieldIcon,
  'shield-off': ShieldOffIcon,
  thread: ThreadIcon,
  weave: WeaveIcon,
  export: ExportIcon,
  close: StopIcon,
  chat: ChatIcon,
};

/** The house SVG for a command palette row, sized to the menu icon slot. */
export function CommandIconGlyph({ name, size = 14 }: { name: CommandIcon; size?: number }) {
  const Icon = COMMAND_ICONS[name];
  return <Icon size={size} />;
}
