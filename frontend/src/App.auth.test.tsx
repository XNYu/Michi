import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './App';
import { useAuthSession } from './services/auth';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  useSession: vi.fn(),
  session: { isPending: false, data: null as { user: { id: string; name: string } } | null },
}));
vi.mock('./services/auth', async () => {
  const actual = await vi.importActual<typeof import('./services/auth')>('./services/auth');
  return { ...actual, fetchAuthConfig: mocks.config, authClient: { useSession: mocks.useSession } };
});
vi.mock('./state/chatStore', async () => {
  const actual = await vi.importActual<typeof import('./state/chatStore')>('./state/chatStore');
  return { ...actual, ChatProvider: ({ children, userId }: { children: React.ReactNode; userId?: string }) => (
    <div data-testid="chat-owner" data-user-id={userId ?? 'local'}>{children}</div>
  ) };
});
vi.mock('./components/LandingPage', () => ({ LandingPage: () => <div>Sign in</div> }));

function Account() {
  const session = useAuthSession();
  return <span>{session?.user.name ?? 'Local account'}</span>;
}

beforeEach(() => {
  mocks.config.mockReset();
  mocks.useSession.mockReset().mockImplementation(() => mocks.session);
  mocks.session = { isPending: false, data: null };
});

describe('AuthGate', () => {
  it('never requests a session on no-auth backends, including StrictMode remounts', async () => {
    mocks.config.mockResolvedValue({ requireAuth: false });
    render(<React.StrictMode><AuthGate><Account /></AuthGate></React.StrictMode>);
    expect(await screen.findByText('Local account')).not.toBeNull();
    expect(mocks.useSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('chat-owner').getAttribute('data-user-id')).toBe('local');
  });

  it('waits for the public probe before subscribing to an authenticated session', async () => {
    let resolve!: (config: { requireAuth: boolean }) => void;
    mocks.config.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<AuthGate><Account /></AuthGate>);
    expect(mocks.useSession).not.toHaveBeenCalled();
    await act(async () => resolve({ requireAuth: true }));
    expect(await screen.findByText('Sign in')).not.toBeNull();
    expect(screen.queryByTestId('chat-owner')).toBeNull();
  });

  it('shares the authenticated user with account views and clears them on sign-out', async () => {
    mocks.config.mockResolvedValue({ requireAuth: true });
    mocks.session = { isPending: false, data: { user: { id: 'user-1', name: 'Test user' } } };
    const view = render(<AuthGate><Account /></AuthGate>);
    expect(await screen.findByText('Test user')).not.toBeNull();
    expect(screen.getByTestId('chat-owner').getAttribute('data-user-id')).toBe('user-1');
    mocks.session = { isPending: false, data: null };
    view.rerender(<AuthGate><Account /></AuthGate>);
    await waitFor(() => expect(screen.getByText('Sign in')).not.toBeNull());
    expect(screen.queryByText('Test user')).toBeNull();
  });
});
