import React from 'react';
import type { Project } from '../../../state/chatTypes';
import type { BulkActions } from './ChatTreeList';
import { confirmDialog } from '../../ui/ConfirmDialog';
import FolderList from './FolderList';

interface Props {
  workspace: Project;
  onSaveInstructions: (text: string) => void;
  onAddFolder: (projectId: string, path: string, label?: string) => void;
  onRemoveFolder: (projectId: string, folderId: string) => void;
  onUpdateFolderLabel: (projectId: string, folderId: string, label: string) => void;
  manageMode: boolean;
  onToggleManageMode: () => void;
  bulkActions?: BulkActions;
  hasArchivedSelection?: boolean;
}

const panelStyle: React.CSSProperties = {
  background: 'var(--term-surface, #fff)',
  border: '1px solid var(--term-line)',
  padding: '16px 18px 14px',
  marginBottom: 14,
};

const panelHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const panelTitle: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 15,
  lineHeight: 1.3,
  fontWeight: 500,
  color: 'var(--term-fg)',
  margin: 0,
};

const subtleBadge: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 11,
  color: 'var(--term-muted)',
  padding: '2px 6px',
  background: 'var(--term-surface-2, var(--term-alt))',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
};

const bodyText: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 13,
  lineHeight: 1.55,
  color: 'var(--term-mid, var(--term-fg))',
};

const faintMeta: React.CSSProperties = {
  fontFamily: 'var(--ui-font)',
  fontSize: 11,
  color: 'var(--term-faint, var(--term-muted))',
  marginTop: 2,
};

export default function ManageSidebar({
  workspace,
  onSaveInstructions,
  onAddFolder,
  onRemoveFolder,
  onUpdateFolderLabel,
  manageMode,
  onToggleManageMode,
  bulkActions,
  hasArchivedSelection,
}: Props) {
  const saved = workspace.instructions ?? '';
  const [instr, setInstr] = React.useState(saved);
  // Reset the draft whenever we navigate to a different workspace, or the
  // hydrated value changes underneath us (e.g. another tab saved it).
  React.useEffect(() => {
    setInstr(saved);
  }, [workspace.id, saved]);
  const dirty = instr !== saved;

  return (
    <aside
      style={{
        padding: '24px 36px 60px 8px',
        overflowY: 'auto',
        minHeight: 0,
      }}
    >
      <div style={panelStyle}>
        <div style={panelHeader}>
          <h3 style={panelTitle}>Instructions</h3>
          <span style={{ flex: 1 }} />
          <EditGlyph color="var(--term-muted)" />
        </div>
        <textarea
          rows={9}
          value={instr}
          onChange={(e) => setInstr(e.target.value)}
          placeholder="System prompt for this workspace…"
          style={{
            width: '100%',
            border: 'none',
            background: 'transparent',
            outline: 'none',
            fontFamily: 'var(--ui-font)',
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--term-mid, var(--term-fg))',
            padding: 0,
            marginTop: 10,
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            ...faintMeta,
            marginTop: 8,
          }}
        >
          <span>
            {instr.length} chars · ~{Math.round(instr.length / 4)} tokens
            {dirty && (
              <span style={{ color: 'var(--term-accent)', marginLeft: 6 }}>· unsaved</span>
            )}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => onSaveInstructions(instr)}
            disabled={!dirty}
            style={{
              fontFamily: 'var(--ui-font)',
              fontSize: 12,
              padding: '4px 12px',
              background: dirty ? 'var(--term-fg)' : 'var(--term-line)',
              color: 'var(--term-bg, #fff)',
              border: 'none',
              cursor: dirty ? 'pointer' : 'default',
              opacity: dirty ? 1 : 0.6,
            }}
          >
            Save
          </button>
        </div>
      </div>
      {/* Folders panel */}
      <div style={panelStyle}>
        <div style={panelHeader}>
          <h3 style={panelTitle}>Folders</h3>
          <span style={{ flex: 1 }} />
          <span style={subtleBadge}>{(workspace.folders ?? []).length}</span>
        </div>
        <FolderList
          folders={workspace.folders ?? []}
          projectId={workspace.id}
          onAddFolder={onAddFolder}
          onRemoveFolder={onRemoveFolder}
          onUpdateLabel={onUpdateFolderLabel}
        />
      </div>
      {/* Manage panel */}
      <div style={panelStyle}>
        <div style={panelHeader}>
          <h3 style={panelTitle}>Manage</h3>
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!manageMode ? (
            <button
              type="button"
              onClick={onToggleManageMode}
              style={{
                border: '1px solid var(--term-line)',
                background: 'transparent',
                color: 'var(--term-fg)',
                padding: '6px 14px',
                fontFamily: 'var(--ui-font)',
                fontSize: 12,
                cursor: 'pointer',
                letterSpacing: '.02em',
                width: '100%',
                textAlign: 'left',
              }}
            >
              ☐ Select threads…
            </button>
          ) : (
            <>
              <div style={{ ...bodyText, fontSize: 12, fontWeight: 600, color: 'var(--term-fg)' }}>
                {bulkActions?.treeSelection.size ?? 0} selected
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <SidebarManageBtn label="Select all" onClick={() => bulkActions?.selectAllTrees()} />
                {(bulkActions?.treeSelection.size ?? 0) > 0 && (
                  <>
                    {hasArchivedSelection ? (
                      <SidebarManageBtn label="Unarchive" onClick={() => bulkActions?.bulkUnarchiveTrees()} />
                    ) : (
                      <SidebarManageBtn label="Archive" onClick={() => bulkActions?.bulkArchiveTrees()} />
                    )}
                    <SidebarManageBtn
                      label="Delete"
                      danger
                      onClick={() => {
                        const count = bulkActions?.treeSelection.size ?? 0;
                        void confirmDialog({
                          title: 'Move to trash',
                          message: `Move ${count} thread${count === 1 ? '' : 's'} to trash?`,
                          confirmLabel: 'Move',
                        }).then((ok) => {
                          if (ok) bulkActions?.bulkDeleteTrees();
                        });
                      }}
                    />
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={onToggleManageMode}
                style={{
                  border: '1px solid var(--term-line)',
                  background: 'transparent',
                  color: 'var(--term-fg)',
                  padding: '5px 14px',
                  fontFamily: 'var(--ui-font)',
                  fontSize: 11,
                  cursor: 'pointer',
                  width: '100%',
                  marginTop: 4,
                }}
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

function SidebarManageBtn({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <span
      role="button"
      onClick={onClick}
      style={{
        cursor: 'pointer',
        color: danger ? 'var(--term-danger, #e55)' : 'var(--term-muted)',
        fontSize: 11,
        padding: '4px 10px',
        border: '1px solid ' + (danger ? 'var(--term-danger, #e55)' : 'var(--term-line)'),
        letterSpacing: '.02em',
      }}
    >
      {label}
    </span>
  );
}

function EyeGlyph() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="1.8" />
    </svg>
  );
}

function EditGlyph({ color }: { color: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 2.5l2.5 2.5L6 12.5 2.5 13.5 3.5 10 11 2.5z" />
    </svg>
  );
}
