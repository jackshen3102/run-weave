import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { journalSchema } from "./journal-schema";
import type { TaskWatch } from "@runweave/shared/task-supervision";

export interface SupervisionJournal {
  version: 1;
  watches: TaskWatch[];
  requests: Record<string, { digest: string; watchId: string }>;
}
export class TaskSupervisionStore {
  constructor(private readonly directory: string) {}
  async load(): Promise<SupervisionJournal> {
    try {
      const raw = JSON.parse(
        await readFile(path.join(this.directory, "watches.json"), "utf8"),
      ) as SupervisionJournal;
      const saved = journalSchema.parse(raw);
      for (const watch of saved.watches) {
        if (watch.status === "classifying") {
          watch.status = "error";
          watch.error = "监听服务已重启，旧分类已取消；恢复后等待新回复。";
        }
        if (
          watch.status === "watching" &&
          watch.decisions.some((d) => d.delivery === "offered")
        ) {
          for (const d of watch.decisions)
            if (d.delivery === "offered") d.delivery = "unknown";
          watch.status = "paused";
          watch.pauseReason = "delivery_unknown";
        }
      }
      return saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { version: 1, watches: [], requests: {} };
    }
  }
  async save(journal: SupervisionJournal): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(this.directory, "watches.json");
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
    await rename(temporary, filename);
  }
}
