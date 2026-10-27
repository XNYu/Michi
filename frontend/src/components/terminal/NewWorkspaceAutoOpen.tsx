import { useEffect, useRef } from 'react';

/**
 * Opens the New workspace dialog once, on first load, while the user has no
 * workspace of their own (`ready`: hydrated, set up, and the runtime usable).
 */
export function NewWorkspaceAutoOpen({ ready, onOpen }: { ready: boolean; onOpen: () => void }) {
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current || !ready) return;
    doneRef.current = true;
    onOpen();
  }, [ready, onOpen]);
  return null;
}
