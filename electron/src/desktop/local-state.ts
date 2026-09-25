import { app } from "electron";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopChannel, isManagedDevSession } from "./config.js";

export function desktopStateRoot(): string {
  const root = app.getPath("userData");
  if (isManagedDevSession && !process.env.RUNWEAVE_DESKTOP_USER_DATA_DIR)
    throw new Error("DESKTOP_STATE_OWNER_MISSING");
  return root;
}
export function desktopStateOwner(desktopId: string) {
  return {
    desktopId,
    channel: desktopChannel,
    devSessionId: process.env.RUNWEAVE_DEV_SESSION_ID?.trim() || null,
  };
}
export function writePrivateJson(target: string, value: unknown): void {
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      /* no temporary file */
    }
    throw error;
  }
}
