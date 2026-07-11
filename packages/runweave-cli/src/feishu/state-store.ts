import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface FeishuBinding {
  messageId: string;
  chatId: string;
  terminalSessionId: string;
  panelId: string | null;
  createdAt: string;
  expiresAt: string;
}

type DeliveryStatus = "processing" | "succeeded" | "failed" | "unknown";

interface ProcessedMessage {
  messageId: string;
  status: DeliveryStatus;
  terminalSessionId: string;
  updatedAt: string;
}

interface FeishuState {
  bindings: Record<string, FeishuBinding>;
  processed: Record<string, ProcessedMessage>;
}

const EMPTY_STATE: FeishuState = { bindings: {}, processed: {} };

export class FeishuStateStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly bridgeLeasePath: string;

  constructor(env: NodeJS.ProcessEnv) {
    const stateDir = env.RUNWEAVE_FEISHU_STATE_DIR?.trim() || join(homedir(), ".runweave", "feishu");
    this.filePath = join(stateDir, "bridge-state.json");
    this.lockPath = join(stateDir, ".bridge-state.lock");
    this.bridgeLeasePath = join(stateDir, "bridge.pid");
  }

  async acquireBridgeLease(): Promise<{ release(): Promise<void> }> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.bridgeLeasePath, "wx", 0o600);
        await handle.writeFile(`${process.pid}\n`, "utf8");
        let released = false;
        return {
          release: async () => {
            if (released) return;
            released = true;
            await handle.close();
            await rm(this.bridgeLeasePath, { force: true });
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const ownerPid = Number((await readFile(this.bridgeLeasePath, "utf8")).trim());
        if (Number.isInteger(ownerPid) && isProcessAlive(ownerPid)) {
          throw new Error(`Feishu Bridge is already running with pid ${ownerPid}`);
        }
        await rm(this.bridgeLeasePath, { force: true });
      }
    }
    throw new Error("Failed to acquire Feishu Bridge process lease");
  }

  async saveBinding(binding: FeishuBinding): Promise<void> {
    await this.mutate((state) => {
      state.bindings[binding.messageId] = binding;
    });
  }

  async getBinding(messageId: string): Promise<FeishuBinding | null> {
    return await this.mutate((state) => state.bindings[messageId] ?? null);
  }

  async beginDelivery(
    messageId: string,
    terminalSessionId: string,
  ): Promise<DeliveryStatus | "started"> {
    return await this.mutate((state) => {
      const existing = state.processed[messageId];
      if (existing) {
        return existing.status === "processing" ? "unknown" : existing.status;
      }
      state.processed[messageId] = {
        messageId,
        status: "processing",
        terminalSessionId,
        updatedAt: new Date().toISOString(),
      };
      return "started";
    });
  }

  async finishDelivery(messageId: string, status: "succeeded" | "failed"): Promise<void> {
    await this.mutate((state) => {
      const existing = state.processed[messageId];
      if (existing) {
        existing.status = status;
        existing.updatedAt = new Date().toISOString();
      }
    });
  }

  private async mutate<T>(operation: (state: FeishuState) => T): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lock = await this.acquireLock();
    try {
      const state = await this.readState();
      this.prune(state);
      const result = operation(state);
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tempPath, this.filePath);
      return result;
    } finally {
      await lock.close();
      await rm(this.lockPath, { force: true });
    }
  }

  private async acquireLock() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        return await open(this.lockPath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error("Timed out waiting for Feishu state lock");
  }

  private async readState(): Promise<FeishuState> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<FeishuState>;
      return {
        bindings: parsed.bindings ?? {},
        processed: parsed.processed ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(EMPTY_STATE);
      }
      throw error;
    }
  }

  private prune(state: FeishuState): void {
    const now = Date.now();
    for (const [messageId, binding] of Object.entries(state.bindings)) {
      if (Date.parse(binding.expiresAt) <= now) {
        delete state.bindings[messageId];
      }
    }
    for (const [messageId, processed] of Object.entries(state.processed)) {
      if (Date.parse(processed.updatedAt) + 24 * 60 * 60 * 1000 <= now) {
        delete state.processed[messageId];
      } else if (processed.status === "processing") {
        processed.status = "unknown";
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
