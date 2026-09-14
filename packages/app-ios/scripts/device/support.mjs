import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const root = resolve(pkg, ".build/ios/device");
export const bundleID = "com.runweave.app.native";
export const project = resolve(pkg, "ios/RunweaveNative.xcodeproj");
export const timestamp = () => new Date().toISOString();
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));
export function writeJSON(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}
export class DeviceError extends Error {
  constructor(reason, phase, nextAction, exitCode = 3, evidencePath) {
    super(reason);
    Object.assign(this, { reason, phase, nextAction, exitCode, evidencePath });
  }
}
export function identity(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    timeout: 2000,
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
// Hash bytes, names, modes and symlink targets, including dirty/untracked inputs.
// A symlink is also a signal to fall back to Xcode: its external input is not modelled.
export function treeDigest(paths) {
  const digest = createHash("sha256");
  let symlinks = false;
  function visit(file, label) {
    digest.update(label + "\0");
    if (!existsSync(file)) {
      digest.update("missing\0");
      return;
    }
    const stat = lstatSync(file);
    digest.update(String(stat.mode) + "\0");
    if (stat.isSymbolicLink()) {
      symlinks = true;
      digest.update(readlinkSync(file));
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) {
        if ([".git", ".build", "xcuserdata"].includes(name)) continue;
        visit(resolve(file, name), `${label}/${name}`);
      }
    } else if (stat.isFile()) digest.update(readFileSync(file));
  }
  paths.forEach((file, index) => visit(file, String(index)));
  return { digest: digest.digest("hex"), symlinks };
}
export function command(
  program,
  args,
  { dir, name, timeout = 10000, onLine, owner, signal: abortSignal } = {},
) {
  const started = Date.now();
  const logPath = dir && resolve(dir, `${name}.log`);
  if (dir) mkdirSync(dir, { recursive: true });
  if (logPath) appendFileSync(logPath, "");
  if (dir)
    appendFileSync(
      resolve(dir, "commands.jsonl"),
      JSON.stringify({
        kind: "command_started",
        at: timestamp(),
        program,
        args,
        name,
      }) + "\n",
    );
  // Record an intent before spawning. A crash in the spawn/PID-record gap stays blocked.
  const token = owner?.begin(program, args);
  return new Promise((resolveResult) => {
    let output = "",
      buffer = "",
      timedOut = false;
    const child = spawn(program, args, {
      cwd: pkg,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    owner?.spawned(token, child.pid);
    const ingest = (chunk) => {
      const text = chunk.toString();
      output = (output + text).slice(-8 * 1024 * 1024);
      if (logPath) appendFileSync(logPath, text);
      buffer += text;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        onLine?.(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    };
    child.stdout.on("data", ingest);
    child.stderr.on("data", ingest);
    let killTimer;
    const signalOwnedGroup = (signal) => {
      if (!child.pid) return;
      // spawn(detached) created this process group exclusively for this command.
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const stop = () => {
      timedOut = true;
      signalOwnedGroup("SIGTERM");
      clearTimeout(killTimer);
      killTimer = setTimeout(() => signalOwnedGroup("SIGKILL"), 5000);
    };
    const timer = setTimeout(stop, timeout);
    abortSignal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      output += error.message;
      if (logPath) appendFileSync(logPath, error.message + "\n");
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", stop);
      if (buffer) onLine?.(buffer);
      owner?.ended(token, code, signal);
      if (timedOut && logPath)
        appendFileSync(
          logPath,
          `\nCommand timed out after ${timeout} ms; signal=${signal}\n`,
        );
      if (dir)
        appendFileSync(
          resolve(dir, "commands.jsonl"),
          JSON.stringify({
            kind: "command_finished",
            at: timestamp(),
            name,
            code,
            signal,
            timedOut,
            durationMs: Date.now() - started,
          }) + "\n",
        );
      resolveResult({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        output,
        evidencePath: logPath,
      });
    });
  });
}
export async function deviceQuery(kind, device, dir, timeout = 10000, owner) {
  const file = resolve(dir, `${kind}.json`);
  const result = await command(
    "xcrun",
    [
      "devicectl",
      "device",
      "info",
      kind,
      "--device",
      device,
      "--timeout",
      String(Math.max(5, Math.floor(timeout / 1000))),
      "--json-output",
      file,
    ],
    { dir, name: kind, timeout, owner },
  );
  try {
    const json = readJSON(file);
    if (result.ok && json.info?.outcome === "success")
      return { ...result, value: json.result, evidencePath: file };
  } catch {
    /* Missing/invalid JSON is unknown, never historical success. */
  }
  return {
    ...result,
    ok: false,
    evidencePath: existsSync(file) ? file : result.evidencePath,
  };
}
