import React from 'react';
import { Copy, History, Pause, Pencil, Play, Trash2 } from 'lucide-react';
import { ActionMenu } from '../../ui/ActionMenu';

export interface ScheduledJobMenuActions {
  onEdit(): void;
  onRuns(): void;
  onToggle(): void;
  onDuplicate(): void;
  onDelete(): void;
}

/** Row "more" menu; same keyboard and dismissal behavior as the Trash menu. */
export function ScheduledJobMenu({ anchor, paused, onClose, actions }: {
  anchor: HTMLButtonElement;
  paused: boolean;
  onClose: () => void;
  actions: ScheduledJobMenuActions;
}) {
  return <ActionMenu anchor={anchor} onClose={onClose} label="Scheduled job actions" items={[
    { id: 'edit', label: 'Edit', icon: <Pencil size={14} aria-hidden="true" />, onSelect: actions.onEdit },
    { id: 'runs', label: 'View runs', icon: <History size={14} aria-hidden="true" />, onSelect: actions.onRuns },
    { id: 'toggle', label: paused ? 'Resume' : 'Pause', icon: paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />, onSelect: actions.onToggle },
    { id: 'duplicate', label: 'Duplicate', icon: <Copy size={14} aria-hidden="true" />, onSelect: actions.onDuplicate },
    { id: 'delete', label: 'Delete…', icon: <Trash2 size={14} aria-hidden="true" />, danger: true, dividerBefore: true, onSelect: actions.onDelete },
  ]} />;
}
