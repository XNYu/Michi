import { useState } from 'react';
import { BorderBtn } from '../../primitives';
import { signOutAndReset } from '../../../../services/signOut';
import { SettingsRow, SettingsSection } from './SettingsSection';

export function AccountPane({ user }: { user: { email: string; name?: string; image?: string | null } }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSignOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOutAndReset();
    } catch (err) {
      setBusy(false);
      setError((err as Error).message || 'Sign-out failed');
    }
  };

  return (
    <SettingsSection title="Account">
      <SettingsRow
        label={
          <span className="settings-account">
            {user.image ? <img src={user.image} alt="" width={32} height={32} /> : null}
            <span className="settings-account__who">
              <span>{user.name || user.email}</span>
              {user.name ? <span className="settings-account__email">{user.email}</span> : null}
            </span>
          </span>
        }
        control={
          <BorderBtn onClick={onSignOut} disabled={busy}>
            {busy ? 'Signing out…' : 'Sign out'}
          </BorderBtn>
        }
      >
        {error && <p className="settings-row__note" role="alert">{error}</p>}
      </SettingsRow>
    </SettingsSection>
  );
}
