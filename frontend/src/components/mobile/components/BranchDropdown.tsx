import React from 'react';
import type { ChatNodeState } from '../../../state/chatTypes';

interface Props {
  childIds: string[];
  nodes: Record<string, ChatNodeState>;
  edges: ReadonlyArray<{ source: string; target: string; kind?: string }>;
  onPick: (nodeId: string) => void;
  onClose: () => void;
}

export default function BranchDropdown({ childIds, nodes, edges, onPick, onClose }: Props) {
  return (
    <>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 28 }}
      />
      <div className="m-branch-popover" role="menu">
        {childIds.map((id, i) => {
          const n = nodes[id];
          const title = n?.title || firstUserText(n) || `branch ${i + 1}`;
          const msgCount = n?.messages.length ?? 0;
          const subBranches = edges.filter(
            (e) =>
              (!e.kind || e.kind === 'branch')
              && e.source === id
              && !nodes[e.target]?.deletedAt,
          ).length;
          return (
            <div
              key={id}
              className="m-branch-row"
              onClick={() => {
                onPick(id);
                onClose();
              }}
            >
              <span className="m-branch-badge">{i + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="m-branch-title">{title}</div>
                <div className="m-branch-meta">
                  {msgCount} msg{msgCount === 1 ? '' : 's'}
                  {subBranches > 0 ? ` · ⑂${subBranches}` : ''}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function firstUserText(node?: { messages: Array<{ role: string; text: string }> }) {
  if (!node) return undefined;
  const m = node.messages.find((x) => x.role === 'user');
  if (!m) return undefined;
  return m.text.split('\n')[0].slice(0, 50);
}
