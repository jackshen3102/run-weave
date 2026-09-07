import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [, salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
