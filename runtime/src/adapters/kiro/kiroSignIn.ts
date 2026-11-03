/** Never includes CLI output or credential material. */
export class KiroSignedOutError extends Error {
  /** `message`: a launch-override agent's own explanation, with how to sign in. */
  constructor(message = 'Kiro is not signed in. Run kiro-cli login, then try again. Background starts are paused until sign-in changes.') {
    super(message);
    this.name = 'KiroSignedOutError';
  }
}

export function isKiroSignInError(value: unknown): boolean {
  const text = value instanceof Error ? value.message : typeof value === 'string' ? value : '';
  return /not (?:logged|signed) in|please log in|kiro(?: cli)? setup or sign-in is required|expiredtokenexception|invalidgrantexception|unauthorizedclientexception|notauthorizedexception/i.test(text);
}
