// This worker must not import Electron: it must keep running while the UI thread is blocked.
import { parentPort, workerData } from "node:worker_threads";
import {
  appendFile,
  chmod,
  mkdir,
  rename,
  rm,
  stat,
  truncate,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const { directory, launchId, mainPid, heartbeat } = workerData as {
  directory: string;
  launchId: string;
  mainPid: number;
  heartbeat: SharedArrayBuffer;
};
const state = new Int32Array(heartbeat);
const logFile = path.join(directory, "events.jsonl");
let queue = Promise.resolve();
let queued = 0;
let dropped = 0;
let sampling = false;
let lastSampleAt = -Infinity;
let sampleSlot = 0;
let sampleWindowAt = performance.now();
let samplesInWindow = 0;
let lastCounter = Atomics.load(state, 0);
let lastHeartbeatAt = performance.now();
let lastTickAt = lastHeartbeatAt;
let stalled = false;

function record(event: string, details: unknown = {}): void {
  if (queued >= 64) {
    dropped += 1;
    return;
  }
  const line = `${JSON.stringify({ at: new Date().toISOString(), launchId, event, details, dropped })}\n`;
  dropped = 0;
  queued += 1;
  queue = queue
    .then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const size = await stat(logFile).then(
        (value) => value.size,
        () => 0,
      );
      if (size + Buffer.byteLength(line) > 1024 * 1024) {
        await rm(`${logFile}.1`, { force: true });
        await rename(logFile, `${logFile}.1`);
      }
      await appendFile(logFile, line, { mode: 0o600 });
    })
    .catch(() => {
      // A broken/full disk must not kill the observer or grow an unbounded queue.
      dropped += 1;
    })
    .finally(() => {
      queued -= 1;
    });
}

function capture(pid: number, reason: string): void {
  const now = performance.now();
  if (now - sampleWindowAt >= 3_600_000) {
    sampleWindowAt = now;
    samplesInWindow = 0;
  }
  if (
    process.platform !== "darwin" ||
    sampling ||
    now - lastSampleAt < 300_000 ||
    samplesInWindow >= 4
  ) {
    record("sample.skipped", { pid, reason, rateLimited: true });
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  sampling = true;
  lastSampleAt = now;
  samplesInWindow += 1;
  const file = path.join(directory, `sample-${sampleSlot++ % 5}.txt`);
  void mkdir(directory, { recursive: true, mode: 0o700 })
    .then(async () => {
      await rm(file, { force: true });
      record("sample.started", { pid, reason, file: path.basename(file) });
      // One second at 20 ms intervals; at most four samples/hour and five retained files.
      execFile(
        "/usr/bin/sample",
        [String(pid), "1", "20", "-file", file],
        {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        },
        (error) => {
          void stat(file)
            .then(async (value) => {
              await chmod(file, 0o600);
              if (value.size > 4 * 1024 * 1024)
                await truncate(file, 4 * 1024 * 1024);
              return value.size > 0;
            })
            .catch(() => false)
            .then((saved) => {
              sampling = false;
              record("sample.completed", {
                pid,
                reason,
                file: path.basename(file),
                ok: !error && saved,
                errorCode: error?.code ?? null,
              });
            });
        },
      );
    })
    .catch(() => {
      sampling = false;
      record("sample.failed", { pid, reason });
    });
}

parentPort?.on(
  "message",
  (message: { event: string; details?: unknown; samplePid?: number }) => {
    record(message.event, message.details);
    if (message.samplePid) capture(message.samplePid, message.event);
  },
);

setInterval(() => {
  const now = performance.now();
  const counter = Atomics.load(state, 0);
  const gap = now - lastTickAt;
  lastTickAt = now;
  if (Atomics.load(state, 1) || gap > 3_000) {
    if (gap > 3_000) record("observer.gap", { durationMs: Math.round(gap) });
    lastCounter = counter;
    lastHeartbeatAt = now;
    stalled = false;
    return;
  }
  if (counter !== lastCounter) {
    if (stalled)
      record("main.recovered", {
        durationMs: Math.round(now - lastHeartbeatAt),
      });
    lastCounter = counter;
    lastHeartbeatAt = now;
    stalled = false;
    return;
  }
  if (!stalled && now - lastHeartbeatAt >= 3_000) {
    stalled = true;
    record("main.stalled", {
      durationMs: Math.round(now - lastHeartbeatAt),
      pid: mainPid,
      loadAverage: os.loadavg(),
      freeMemoryBytes: os.freemem(),
      totalMemoryBytes: os.totalmem(),
      processRssBytes: process.memoryUsage.rss(),
    });
    capture(mainPid, "main.stalled");
  }
}, 1_000);
record("observer.started", { mainPid, stallThresholdMs: 3_000 });
