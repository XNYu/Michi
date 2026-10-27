import React from 'react';
import type { BlockProps } from '../blockTypes';

export function DatabaseRefBlock({ block, ctx }: BlockProps) {
  return <>{ctx.renderNativeDatabaseRef?.(block) ?? <p role="status">This database is unavailable.</p>}</>;
}
