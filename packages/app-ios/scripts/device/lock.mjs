import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  alive,
  DeviceError,
  identity,
  pkg,
  readJSON,
  timestamp,
  writeJSON,
} from "./support.mjs";

export const lockPath = (udid) =>
  resolve(homedir(), ".runweave/native-device/locks", udid);
export function inspectLock(udid) {
  const path = lockPath(udid);
  if (!existsSync(path)) return null;
  try {
    return { ...readJSON(resolve(path, "owner.json")), path };
  } catch {
    return { path, reason: "owner_identity_unknown" };
  }
}
export function acquireLock(udid, runId) {
  const path = lockPath(udid);
  mkdirSync(resolve(path, ".."), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new DeviceError(
      "device_busy",
      "checking",
      "Inspect owner.json and coordinate with its owner; never reclaim unknown children",
      3,
      path,
    );
  }
  const owner = {
    runId,
    worktree: realpathSync(pkg),
    pid: process.pid,
    startIdentity: identity(process.pid),
    udid,
    startedAt: timestamp(),
    children: [],
  };
  const save = () => writeJSON(resolve(path, "owner.json"), owner);
  save();
  return {
    owner,
    begin(program, args) {
      const token = owner.children.length;
      owner.children.push({
        program,
        args,
        startedAt: timestamp(),
        state: "spawning",
      });
      save();
      return token;
    },
    spawned(token, pid) {
      Object.assign(owner.children[token], {
        pid,
        processGroup: pid,
        startIdentity: pid ? identity(pid) : null,
        state: "running",
      });
      save();
    },
    ended(token, code, signal) {
      Object.assign(owner.children[token], {
        state: "exited",
        code,
        signal,
        endedAt: timestamp(),
      });
      save();
    },
    release() {
      // A surviving descendant (even after the direct child exits) retains the lock.
      const uncertain = owner.children.some(
        (child) =>
          child.state !== "exited" ||
          (child.processGroup && alive(-child.processGroup)),
      );
      if (uncertain || inspectLock(udid)?.runId !== runId) return false;
      rmSync(path, { recursive: true });
      return true;
    },
  };
}
