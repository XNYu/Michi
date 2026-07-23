import { useState } from 'react';
import { BorderBtn } from '../../primitives';
import { signOutAndReset } from '../../../../services/signOut';

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, fontSize: 12 }}>
      <div>
        <div style={{ fontSize: 11, color: 'var(--term-muted)', marginBottom: 4 }}>
          signed in as
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {user.image ? (
            <img
              src={user.image}
              alt=""
              width={32}
              height={32}
              style={{ borderRadius: '50%', objectFit: 'cover' }}
            />
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {user.name ? <span style={{ fontWeight: 600 }}>{user.name}</span> : null}
            <span style={{ color: 'var(--term-muted)' }}>{user.email}</span>
          </div>
        </div>
      </div>

      <div>
        <BorderBtn onClick={onSignOut} disabled={busy}>
          {busy ? 'Signing out…' : 'Sign out'}
        </BorderBtn>
        {error && (
          <div style={{ color: 'var(--term-error, #d33)', fontSize: 11, marginTop: 6 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
