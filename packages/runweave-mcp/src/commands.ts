import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readChunk } from "./files.js";

type Status =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "output_limit";
interface Job {
  id: string;
  command: string;
  cwd: string;
  directory: string;
  child: ChildProcess;
  status: Status;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  bytes: number;
  outputLimit: number;
  error?: string;
  done: Promise<void>;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
}

export class Commands {
  private jobs = new Map<string, Job>();
  private starting = new Set<Promise<string>>();
  private closing = false;
  constructor(
    private directory: string,
    readonly defaultCwd: string,
  ) {}

  static async create(cwd: string) {
    return new Commands(
      await mkdtemp(path.join(tmpdir(), "runweave-mcp-")),
      cwd,
    );
  }

  start(
    command: string,
    cwd = this.defaultCwd,
    timeoutMs = 60_000,
    outputLimit = 64 * 1024 * 1024,
  ) {
    if (this.closing) throw new Error("MCP is shutting down");
    if (
      [...this.jobs.values()].filter((j) => !j.endedAt).length +
        this.starting.size >=
      8
    ) {
      throw new Error(
        "Eight commands are running; read or cancel them before starting another",
      );
    }
    const pending = this.startJob(command, cwd, timeoutMs, outputLimit).finally(
      () => this.starting.delete(pending),
    );
    this.starting.add(pending);
    return pending;
  }

  private async startJob(
    command: string,
    cwd: string,
    timeoutMs: number,
    outputLimit: number,
  ) {
    if (!path.isAbsolute(cwd) || !(await stat(cwd)).isDirectory())
      throw new Error("cwd must be an absolute directory");
    if (this.jobs.size >= 128) {
      const oldest = [...this.jobs.values()].find((j) => Boolean(j.endedAt));
      if (oldest) {
        this.jobs.delete(oldest.id);
        await rm(oldest.directory, { recursive: true, force: true });
      }
    }
    const id = randomUUID();
    const directory = await mkdtemp(path.join(this.directory, "command-"));
    await Promise.all(
      ["stdout", "stderr"].map((s) =>
        writeFile(path.join(directory, s), "", { mode: 0o600 }),
      ),
    );
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: {
        ...process.env,
        PATH: [path.dirname(process.execPath), process.env.PATH]
          .filter(Boolean)
          .join(path.delimiter),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      id,
      command,
      cwd,
      directory,
      child,
      status: "running",
      startedAt: new Date().toISOString(),
      bytes: 0,
      outputLimit,
      done,
    };
    this.jobs.set(id, job);
    for (const [stream, name] of [
      [child.stdout, "stdout"],
      [child.stderr, "stderr"],
    ] as const) {
      stream?.on("data", (chunk: Buffer) => {
        const allowed = chunk.subarray(0, Math.max(0, outputLimit - job.bytes));
        try {
          appendFileSync(path.join(directory, name), allowed);
          job.bytes += allowed.length;
        } catch (error) {
          job.error = String(error);
          this.stop(job, "failed");
        }
        if (allowed.length < chunk.length) this.stop(job, "output_limit");
      });
    }
    child.once("error", (error) => {
      job.error = error.message;
      job.status = "failed";
    });
    child.once("close", (code) => {
      job.exitCode = code;
      job.endedAt = new Date().toISOString();
      if (job.status === "running")
        job.status = code === 0 ? "completed" : "failed";
      clearTimeout(job.timer);
      // A pending SIGKILL still reaps children that ignored SIGTERM.
      finish();
    });
    job.timer = setTimeout(() => this.stop(job, "timed_out"), timeoutMs);
    job.timer.unref();
    return id;
  }

  private stop(job: Job, status: Status) {
    if (job.endedAt || job.killTimer) return;
    job.status = status;
    const signal = (kind: NodeJS.Signals) => {
      if (!job.child.pid) return;
      try {
        process.kill(-job.child.pid, kind);
      } catch {
        /* Already exited. */
      }
    };
    signal("SIGTERM");
    job.killTimer = setTimeout(() => signal("SIGKILL"), 1_000);
    job.killTimer.unref();
  }

  async read(
    id: string,
    stdoutOffset = 0,
    stderrOffset = 0,
    maxBytes = 32_768,
    waitMs = 0,
    cancel = false,
  ) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("command_not_found_or_expired");
    if (cancel) this.stop(job, "cancelled");
    if (waitMs) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        job.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }
    const [stdout, stderr] = await Promise.all([
      readChunk(path.join(job.directory, "stdout"), stdoutOffset, maxBytes),
      readChunk(path.join(job.directory, "stderr"), stderrOffset, maxBytes),
    ]);
    return {
      commandId: id,
      command: job.command,
      cwd: job.cwd,
      status: job.status,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      exitCode: job.exitCode,
      error: job.error,
      processClosed: Boolean(job.endedAt),
      outputLimit: job.outputLimit,
      stdout,
      stderr,
    };
  }

  async close() {
    this.closing = true;
    await Promise.allSettled(this.starting);
    for (const job of this.jobs.values()) this.stop(job, "cancelled");
    await Promise.all([...this.jobs.values()].map((j) => j.done));
    // Let the group-kill timers run before removing command files.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await rm(this.directory, { recursive: true, force: true });
  }
}
