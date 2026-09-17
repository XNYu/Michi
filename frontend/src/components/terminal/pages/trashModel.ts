import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { chatLabel } from '../../../state/chatStore';
import { isArchiveGroupId } from '../../../state/trashActions';

export interface TrashGroup {
  id: string;
  projectId: string;
  deletedAt: number;
  oldestDeletedAt: number;
  root: ChatNodeState;
  title: string;
  members: ChatNodeState[];
  messageCount: number;
}

export interface TrashSection {
  project: Project;
  groups: TrashGroup[];
}

export type TrashEntry =
  | { kind: 'thread'; project: Project; group: TrashGroup }
  | { kind: 'workspace'; project: Project; groups: TrashGroup[] };

export const entryKey = (entry: TrashEntry) => entry.kind === 'thread' ? `thread:${entry.group.id}` : `workspace:${entry.project.id}`;
export const entryTitle = (entry: TrashEntry) => entry.kind === 'thread' ? entry.group.title : entry.project.name;
export const entryDeletedAt = (entry: TrashEntry) => entry.kind === 'thread' ? entry.group.deletedAt : entry.project.deletedAt ?? 0;
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function buildTrashSections(projects: Project[], nodes: Record<string, ChatNodeState>): TrashSection[] {
  const byGroup = new Map<string, ChatNodeState[]>();
  for (const node of Object.values(nodes)) {
    if (!node.deletionGroupId || isArchiveGroupId(node.deletionGroupId)) continue;
    const key = `${node.projectId}:${node.deletionGroupId}`;
    const members = byGroup.get(key) ?? [];
    members.push(node);
    byGroup.set(key, members);
  }
  const byProject = new Map<string, TrashGroup[]>();
  for (const members of byGroup.values()) {
    const ids = new Set(members.map(node => node.nodeId));
    const root = members.find(node => !node.parentNodeId || !ids.has(node.parentNodeId)) ?? members[0];
    const dates = members.map(node => node.deletedAt ?? 0).filter(Boolean);
    const groups = byProject.get(root.projectId) ?? [];
    groups.push({
      id: root.deletionGroupId!, projectId: root.projectId, root, members,
      title: root.title || chatLabel(root) || 'Untitled thread',
      deletedAt: dates.length ? Math.max(...dates) : 0,
      oldestDeletedAt: dates.length ? Math.min(...dates) : 0,
      messageCount: members.reduce((sum, node) => sum + (node.messagesLoaded === true ? node.messages.length : node.messageCount ?? node.messages.length), 0),
    });
    byProject.set(root.projectId, groups);
  }
  return projects.flatMap(project => {
    const groups = byProject.get(project.id) ?? [];
    return project.deletedAt || groups.length ? [{ project, groups }] : [];
  });
}

export function filterTrashSections(sections: TrashSection[], query: string, oldestFirst: boolean): TrashSection[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (text: string) => text.toLocaleLowerCase().includes(needle);
  const direction = oldestFirst ? 1 : -1;
  return sections.flatMap(section => {
    const workspaceMatch = matches(section.project.name) || matches(section.project.cwd ?? '');
    const groups = section.groups.filter(group => workspaceMatch || matches(group.title))
      .sort((a, b) => direction * (a.deletedAt - b.deletedAt));
    // A deleted workspace stays one entry; its preview retains all its contents.
    if (section.project.deletedAt) return workspaceMatch || groups.length ? [section] : [];
    return groups.length ? [{ ...section, groups }] : [];
  }).sort((a, b) => {
    const aTime = a.project.deletedAt ?? a.groups[0]?.deletedAt ?? 0;
    const bTime = b.project.deletedAt ?? b.groups[0]?.deletedAt ?? 0;
    return direction * (aTime - bTime);
  });
}

export function trashItemCount(sections: TrashSection[]) {
  return sections.reduce((sum, section) => sum + (section.project.deletedAt ? 1 : section.groups.length), 0);
}

export function remainingDays(group: TrashGroup, ttl: number, now: number): number | null {
  if (ttl <= 0 || !group.oldestDeletedAt) return null;
  return Math.max(0, Math.ceil((group.oldestDeletedAt + ttl * 86_400_000 - now) / 86_400_000));
}

export function relativeDeletion(ts: number, now: number): string {
  if (!ts) return 'Unknown date';
  const minutes = Math.floor(Math.max(0, now - ts) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`;
}
