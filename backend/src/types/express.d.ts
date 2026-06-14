declare namespace Express {
  interface Request {
    user?: { id: string; email: string };
    session?: { id: string };
  }
}
