/**
 * Spaces and the Meta agent run on this computer's backend only. A workspace
 * on a remote connection is listed, greyed, with this note; nothing is read,
 * queued or written for it.
 */
export const REMOTE_SPACES_NOTE = 'Pages doesn’t support remote connections yet';

/** This computer's own connection id (LOCAL_BACKEND_CONNECTION_ID). */
export function spacesSupportsConnection(connectionId: string): boolean {
  return connectionId === 'local';
}
