import type { ContextEntry } from '../state/chatStore';

export interface ContextRowMenuItem {
    label: string;
    action: () => void;
    danger?: boolean;
    /** Single-letter keyboard accelerator (e.g. 'R'); fires while menu is open. */
    keys?: string;
}

export function buildContextRowMenu(opts: {
    context: ContextEntry;
    onToggleAutoInject: () => void;
    onRename: () => void;
    onDelete: () => void;
}): ContextRowMenuItem[] {
    const { context, onToggleAutoInject, onRename, onDelete } = opts;
    return [
        {
            label: context.pinnedAt ? 'Remove from favorites' : 'Add to favorites',
            keys: 'F',
            action: onPin,
        },
        { label: 'Rename', keys: 'R', action: onRename },
        { label: 'Delete', keys: 'D', action: onDelete, danger: true },
    ];
}
