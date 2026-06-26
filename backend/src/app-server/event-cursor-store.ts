import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AppServerEventCursor {
  lastEventId: string;
  updatedAt: string;
}

type CursorFile = Record<string, AppServerEventCursor>;

export class AppServerEventCursorStore {
  constructor(private readonly filePath: string) {}

  async read(consumerId: string): Promise<string | null> {
    const cursors = await this.readFile();
    return cursors[consumerId]?.lastEventId ?? null;
  }

  async write(consumerId: string, lastEventId: string): Promise<void> {
    const cursors = await this.readFile();
    cursors[consumerId] = {
      lastEventId,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(cursors, null, 2)}\n`);
  }

  private async readFile(): Promise<CursorFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return {};
      }
      return parsed as CursorFile;
    } catch {
      return {};
    }
  }
}
