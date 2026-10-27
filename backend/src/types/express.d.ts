declare namespace Express {
  interface Request {
    /** Verified login identity; local authentication is not a data owner. */
    authUser?: { id: string; email: string; emailVerified?: boolean };
    user?: { id: string; email: string; emailVerified?: boolean };
    session?: { id: string };
  }
}
