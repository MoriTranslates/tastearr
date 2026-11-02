import { db } from "./db.js";

/** Logged-out session cookies (by SHA-256), kept until they would have expired anyway. */

export function isRevoked(hash: string) {
  return !!db.prepare("SELECT 1 FROM revoked_sessions WHERE hash = ?").get(hash);
}

export function revoke(hash: string, exp: number) {
  db.prepare("DELETE FROM revoked_sessions WHERE exp < ?").run(Date.now());
  db.prepare("INSERT OR IGNORE INTO revoked_sessions (hash, exp) VALUES (?, ?)").run(hash, exp);
}
