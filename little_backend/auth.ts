import type { Session, Result } from "./types.js";
import { getUser, getUserByEmail } from "./db.js";

const sessions = new Map<string, Session>();

export function hashPassword(password: string): string {
  return Array.from(password).reduce((h, c) => (((h << 5) - h) + c.charCodeAt(0)) | 0, 0).toString(36);
}

export function login(email: string, password: string): Result<Session> {
  const user = getUserByEmail(email);
  if (!user || user.password !== hashPassword(password)) {
    return { ok: false, error: "invalid credentials" };
  }

  const session: Session = {
    token: crypto.randomUUID(),
    userId: user.id,
    expiresAt: Date.now() + 3600000,
  };
  sessions.set(session.token, session);
  return { ok: true, data: session };
}

export function verify(token: string): Result<Session> {
  const s = sessions.get(token);
  if (!s) return { ok: false, error: "invalid token" };
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return { ok: false, error: "expired" };
  }
  return { ok: true, data: s };
}

export function logout(token: string) {
  sessions.delete(token);
}

export function requireAdmin(token: string): Result<null> {
  const s = verify(token);
  if (!s.ok) return s;
  const user = getUser(s.data.userId);
  if (!user || user.role !== "admin") return { ok: false, error: "forbidden" };
  return { ok: true, data: null };
}
