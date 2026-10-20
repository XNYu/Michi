import { useCallback, useState } from 'react';
import { postDeskMutation, type DeskMutation } from '../../../../services/api/desk';
import { deskUndoLabel, setDeskUndo } from './DeskChrome';

export function useDeskActions(refresh: () => void) {
  const [pending, setPending] = useState(false);
  const act = useCallback(async (action: DeskMutation, ids: string[]) => {
    if (ids.length === 0 || pending) return;
    setPending(true);
    try {
      const write = await postDeskMutation(action, ids);
      setDeskUndo({ id: write.receipt.id, label: deskUndoLabel(action, ids.length) });
      window.dispatchEvent(new CustomEvent('michi:desk-changed'));
      refresh();
    } finally {
      setPending(false);
    }
  }, [pending, refresh]);
  return { act, pending };
}
