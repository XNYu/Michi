import { useSyncExternalStore } from 'react';

const subscribe = (notify: () => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};
const snapshot = () => window.innerWidth <= 700;
export function usePhoneLayout() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
