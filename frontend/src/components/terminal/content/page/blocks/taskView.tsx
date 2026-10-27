import React from 'react';
import type { BlockProps } from '../blockTypes';

/** A task board: the host draws the workspace's task database; without one it says so. */
export function TaskViewBlock({ block, ctx }: BlockProps) {
  return <>{ctx.renderNativeTaskView?.(block) ?? <p className="michi-doc-unknown" role="status">The task board is unavailable here.</p>}</>;
}
