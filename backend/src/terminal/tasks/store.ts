import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { TerminalTask } from "@runweave/shared/terminal/task";

/** Small execution ledger; no scheduler, credentials, or model-generated state. */
export class TerminalTaskStore {
  readonly tasks = new Map<string, TerminalTask>();
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;
  private closed = false;

  constructor(private readonly file: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await readFile(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error("Invalid terminal task ledger");
      for (const task of data.tasks as TerminalTask[]) {
        if (typeof task.taskId !== "string" || !Number.isInteger(task.revision) ||
          !Array.isArray(task.dispatches) || !Array.isArray(task.reviews) || this.tasks.has(task.taskId))
          throw new Error("Invalid terminal task record");
        // A crash can occur between a human key and its persistence. Never silently
        // restore automatic write ownership after a Backend restart.
        task.control = "human";
        task.controlReason = "backend_restarted";
        task.revision += 1;
        this.tasks.set(task.taskId, task);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.save();
  }

  assertWritable(): void {
    if (this.closed || this.failure) throw new Error("Terminal task ledger unavailable; automatic input disabled");
  }

  save(): Promise<void> {
    this.assertWritable();
    const body = JSON.stringify({ version: 1, tasks: [...this.tasks.values()] });
    const work = this.tail.then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(body);
        await handle.sync();
        await handle.close();
        await rename(temporary, this.file);
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
    });
    this.tail = work;
    void work.catch((error) => { this.failure = error; });
    return work;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
