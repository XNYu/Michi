import React from 'react';
import type { ChatNodeState } from '../../../state/chatTypes';

interface Props {
  spawnedChildren: ChatNodeState[];
  onPick: (nodeId: string) => void;
}

/**
 * System-style card rendered in the message stream when the agent spawned new
 * branches via `spawn_branches`. Lists each child with a tap-to-jump affordance.
 * The desktop UX opens panes for each spawn; on mobile we let the user choose.
 */
export default function SpawnCard({ spawnedChildren, onPick }: Props) {
  if (spawnedChildren.length === 0) return null;
  return (
    <div className="m-msg" data-role="system">
      <div className="m-msg-body">
        <div style={{ fontWeight: 600, marginBottom: 6 }}>
          🤖 Agent spawned {spawnedChildren.length} branch
          {spawnedChildren.length === 1 ? '' : 'es'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {spawnedChildren.map((c, i) => (
            <button
              key={c.nodeId}
              className="m-followup-card"
              onClick={() => onPick(c.nodeId)}
            >
              <span className="m-followup-badge">{i + 1}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {c.title || firstUserText(c) || 'spawned'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function firstUserText(node: ChatNodeState) {
  const m = node.messages.find((x) => x.role === 'user');
  if (!m) return undefined;
  return m.text.split('\n')[0].slice(0, 40);
}
