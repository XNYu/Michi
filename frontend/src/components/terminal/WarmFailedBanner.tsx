import React from 'react';
import { useChatProjects } from '../../state/chatStore';

/**
 * Cold-start banner shown when /api/ready reports `failed` (e.g. kiro-cli
 * ENOENT) and we have no agentStatus yet. Retry dispatches the same reload
 * event chatStore already listens to; chatStore's reload-handler skips the
 * ready poll and re-fetches /agent/status directly.
 *
 * Renders nothing once agentStatus is populated, so a successful retry
 * removes the banner without extra plumbing.
 */
export default function WarmFailedBanner() {
  const { agentStatus, warmFailedError } = useChatProjects();
  if (agentStatus || !warmFailedError) return null;
  return (
    <div className="boot-warm-failed" role="alert">
      Runtime failed to start: {warmFailedError}.{' '}
      <button
        onClick={() =>
          window.dispatchEvent(new CustomEvent('michi:reload-agent-status'))
        }
      >
        Retry
      </button>
    </div>
  );
}
