import crypto from "node:crypto";
import { promisify } from "node:util";

/** Password hashing and constant-time comparison. */

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** "salt:hash" in hex, scrypt with a random 16-byte salt. */
export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("hex")}:${(await scrypt(password, salt, 32)).toString("hex")}`;
}

export async function checkPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = await scrypt(pw, Buffer.from(salt, "hex"), 32);
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

/** Constant-time comparison. Both sides are hashed first, so not even the length of the secret leaks through timing. */
export function safeEqual(a: string | undefined, b: string) {
  if (typeof a !== "string" || !a || !b) return false;
  const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
  return crypto.timingSafeEqual(digest(a), digest(b));
}
