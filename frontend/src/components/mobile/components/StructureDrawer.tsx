import React from 'react';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { buildTree, type TreeNode } from '../../../state/tree';

interface Props {
  project: Project;
  nodes: Record<string, ChatNodeState>;
  currentNodeId: string;
  rootNodeId: string;
  onPickNode: (nodeId: string) => void;
  onClose: () => void;
}

/**
 * Slide-in left drawer showing a DFS render of the active tree plus the
 * workspace's contexts. Picking any node navigates and closes the drawer.
 */
export default function StructureDrawer({
  project,
  nodes,
  currentNodeId,
  rootNodeId,
  onPickNode,
  onClose,
}: Props) {
  const root = React.useMemo(
    () => buildTree(rootNodeId, project.edges, (id) => !nodes[id]?.deletedAt),
    [rootNodeId, project.edges, nodes],
  );

  const items = React.useMemo<Array<{ depth: number; node: TreeNode }>>(() => {
    const out: Array<{ depth: number; node: TreeNode }> = [];
    const walk = (n: TreeNode, d: number) => {
      out.push({ depth: d, node: n });
      for (const c of n.children) walk(c, d + 1);
    };
    walk(root, 0);
    return out;
  }, [root]);

  return (
    <>
      <div className="m-drawer-scrim" onClick={onClose} />
      <aside className="m-drawer term-glass" role="dialog" aria-label="Structure">
        <div className="m-drawer-header">Structure</div>
        <div className="m-drawer-tree">
          {items.map(({ depth, node }) => {
            const n = nodes[node.nodeId];
            const title = n?.title || firstUserText(n) || 'untitled';
            const childCount = node.children.length;
            return (
              <div
                key={node.nodeId}
                className="m-drawer-node"
                data-current={node.nodeId === currentNodeId}
                onClick={() => {
                  onPickNode(node.nodeId);
                  onClose();
                }}
                style={{ paddingLeft: 14 + depth * 14 }}
              >
                <span style={{ color: 'var(--term-faint)', flexShrink: 0 }}>
                  {depth === 0 ? '●' : '◦'}
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {title}
                </span>
                {childCount > 0 && (
                  <span style={{ color: 'var(--term-faint)', fontSize: 10 }}>
                    ⑂{childCount}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {(project.contexts ?? []).length > 0 && (
          <>
            <div className="m-drawer-divider" />
            <div className="m-drawer-section-label">Artifacts</div>
            <div style={{ paddingBottom: 12 }}>
              {(project.contexts ?? []).map((c) => (
                <div key={c.id} className="m-drawer-node" style={{ paddingLeft: 14 }}>
                  <span style={{ color: 'var(--term-faint)' }}>📄</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.name}
                  </span>
                  {c.pinnedAt && (
                    <span style={{ color: 'var(--term-accent)', fontSize: 10 }}>pin</span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </aside>
    </>
  );
}

function firstUserText(node?: ChatNodeState) {
  if (!node) return undefined;
  const m = node.messages.find((x) => x.role === 'user');
  if (!m) return undefined;
  return m.text.split('\n')[0].slice(0, 36);
}
