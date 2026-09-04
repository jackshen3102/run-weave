import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export function isPidLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function inspectRecordedProcessState(filePath, pidPath) {
  let handle;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error("recorded process state is not a regular file");
    }
    const value = JSON.parse(await handle.readFile("utf8"));
    const named = await fs.lstat(filePath);
    if (
      named.isSymbolicLink() ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino
    ) {
      throw new Error("recorded process state identity changed while reading");
    }
    const pid = pidPath.reduce((current, key) => current?.[key], value);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("recorded process state has no valid PID");
    }
    return {
      path: filePath,
      exists: true,
      trusted: true,
      active: isPidLive(pid),
      pid,
      reason: null,
    };
  } catch (error) {
    return {
      path: filePath,
      exists: error?.code !== "ENOENT",
      trusted: false,
      active: false,
      pid: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await handle?.close();
  }
}

export async function runCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        ok: code === 0,
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

export function isExternalTmuxReference(line, targetPaths) {
  const executable = /^(?:\d+)\s+(\S+)/.exec(line)?.[1] ?? "";
  return (
    path.basename(executable) === "tmux" &&
    !targetPaths.some((targetPath) => executable.includes(targetPath))
  );
}

export async function inspectProcessReferences(targetPaths) {
  const normalizedPaths = targetPaths
    .filter((targetPath) => typeof targetPath === "string" && targetPath)
    .map((targetPath) => path.resolve(targetPath));
  const result = await runCapture("ps", ["-axo", "pid=,command="]);
  if (!result.ok) {
    return {
      trusted: false,
      active: false,
      identities: [],
      reason: result.stderr.trim() || "process inventory failed",
    };
  }
  const identities = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const match = /^(\d+)\s+/.exec(line);
      const pid = Number.parseInt(match?.[1] ?? "", 10);
      return (
        Number.isInteger(pid) &&
        pid !== process.pid &&
        !isExternalTmuxReference(line, normalizedPaths) &&
        normalizedPaths.some((targetPath) => line.includes(targetPath))
      );
    });
  return {
    trusted: true,
    active: identities.length > 0,
    identities,
    reason: null,
  };
}
