import {
  appendFile,
  open,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  TERMINAL_COMPACTED_SCROLLBACK_BYTES,
  TERMINAL_LIVE_SCROLLBACK_BYTES,
  TERMINAL_PERSISTED_SCROLLBACK_BYTES,
} from "@runweave/shared/terminal-limits";
import type {
  AppendTerminalSessionScrollbackParams,
  UpdateTerminalSessionScrollbackParams,
} from "./store";
import { getLiveTerminalScrollback } from "./live-scrollback";
import { LowDbStoreBase } from "./lowdb-store-base";

const LIVE_SCROLLBACK_READ_BYTES = TERMINAL_LIVE_SCROLLBACK_BYTES + 4;
const UTF8_BOUNDARY_READ_BYTES = 3;

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

export class LowDbScrollbackStore extends LowDbStoreBase {
  async readSessionScrollback(terminalSessionId: string): Promise<string> {
    return this.readScrollbackFile(terminalSessionId);
  }

  async readSessionLiveScrollback(terminalSessionId: string): Promise<string> {
    return this.readLiveScrollbackFile(terminalSessionId);
  }

  async updateSessionScrollback(
    params: UpdateTerminalSessionScrollbackParams,
  ): Promise<void> {
    await this.enqueueScrollbackWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      await this.writeScrollbackFile(
        params.terminalSessionId,
        params.scrollback,
      );
    });
  }

  async appendSessionScrollback(
    params: AppendTerminalSessionScrollbackParams,
  ): Promise<void> {
    if (!params.chunk) {
      return;
    }

    await this.enqueueScrollbackWrite(async () => {
      const database = this.getDatabase();
      const session = database.data.sessions.find(
        (candidate) => candidate.id === params.terminalSessionId,
      );
      if (!session) {
        return;
      }

      await this.appendScrollbackFile(params.terminalSessionId, params.chunk);
    });
  }

  private resolveScrollbackFile(terminalSessionId: string): string {
    return path.join(
      this.scrollbackDir,
      `${encodeURIComponent(terminalSessionId)}.log`,
    );
  }

  private async readScrollbackFile(terminalSessionId: string): Promise<string> {
    try {
      return await readFile(
        this.resolveScrollbackFile(terminalSessionId),
        "utf8",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  private async readLiveScrollbackFile(
    terminalSessionId: string,
  ): Promise<string> {
    const scrollbackFile = this.resolveScrollbackFile(terminalSessionId);
    try {
      const stats = await stat(scrollbackFile);
      if (stats.size <= 0) {
        return "";
      }

      const bytesToRead = Math.min(stats.size, LIVE_SCROLLBACK_READ_BYTES);
      const file = await open(scrollbackFile, "r");
      try {
        const buffer = Buffer.alloc(bytesToRead);
        const { bytesRead } = await file.read(
          buffer,
          0,
          bytesToRead,
          stats.size - bytesToRead,
        );
        let tail = buffer.toString("utf8", 0, bytesRead);
        if (stats.size > bytesToRead) {
          const firstLineBreak = tail.indexOf("\n");
          if (firstLineBreak >= 0 && firstLineBreak < tail.length - 1) {
            tail = tail.slice(firstLineBreak + 1);
          }
        }
        return getLiveTerminalScrollback(tail);
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return "";
      }
      throw error;
    }
  }

  protected async writeScrollbackFile(
    terminalSessionId: string,
    scrollback: string,
  ): Promise<void> {
    await mkdir(this.scrollbackDir, { recursive: true });
    await writeFile(
      this.resolveScrollbackFile(terminalSessionId),
      scrollback,
      "utf8",
    );
  }

  private async appendScrollbackFile(
    terminalSessionId: string,
    chunk: string,
  ): Promise<void> {
    await mkdir(this.scrollbackDir, { recursive: true });
    const scrollbackFile = this.resolveScrollbackFile(terminalSessionId);
    await appendFile(scrollbackFile, chunk, "utf8");

    const stats = await stat(scrollbackFile);
    if (stats.size <= TERMINAL_PERSISTED_SCROLLBACK_BYTES) {
      return;
    }

    const bytesToRead = Math.min(
      stats.size,
      TERMINAL_COMPACTED_SCROLLBACK_BYTES + UTF8_BOUNDARY_READ_BYTES,
    );
    const file = await open(scrollbackFile, "r");
    let compactedScrollback: Buffer;
    try {
      const tail = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await file.read(
        tail,
        0,
        bytesToRead,
        stats.size - bytesToRead,
      );
      let start = Math.max(0, bytesRead - TERMINAL_COMPACTED_SCROLLBACK_BYTES);
      while (start < bytesRead && isUtf8ContinuationByte(tail[start] ?? 0)) {
        start += 1;
      }
      compactedScrollback = tail.subarray(start, bytesRead);
    } finally {
      await file.close();
    }
    await writeFile(scrollbackFile, compactedScrollback);
  }

  protected async deleteScrollbackFile(
    terminalSessionId: string,
  ): Promise<void> {
    await rm(this.resolveScrollbackFile(terminalSessionId), { force: true });
  }
}
