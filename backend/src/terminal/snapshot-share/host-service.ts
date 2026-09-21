import type { PublishTerminalSnapshotResponse, TerminalSnapshotShareAccess } from "@runweave/shared/terminal/snapshot-share";
import { TerminalSnapshotShareError } from "./errors";
import { TerminalSnapshotShareStore } from "./store";

/** Owns the cloud store independently of Terminal/tmux and the main Backend process. */
export class TerminalSnapshotHostService {
  private readonly uploads = new Set<Promise<PublishTerminalSnapshotResponse>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintenance: Promise<void> | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(private readonly store: TerminalSnapshotShareStore) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.timer = setInterval(() => {
      if (this.maintenance) return;
      this.maintenance = this.store.cleanup().catch(() => {
        console.error("Snapshot host cleanup failed");
      }).finally(() => { this.maintenance = undefined; });
    }, 60_000);
    this.timer.unref();
  }

  read(access: TerminalSnapshotShareAccess) {
    return this.store.read(access);
  }

  save(title: string, text: string): Promise<PublishTerminalSnapshotResponse> {
    if (this.disposed || this.uploads.size >= 4) {
      return Promise.reject(new TerminalSnapshotShareError("SNAPSHOT_BUSY"));
    }
    const upload = this.store.save(title, text);
    this.uploads.add(upload);
    void upload.finally(() => this.uploads.delete(upload)).catch(() => undefined);
    return upload;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    clearInterval(this.timer);
    this.disposal = Promise.allSettled([...this.uploads, ...(this.maintenance ? [this.maintenance] : [])]).then(() => undefined);
    return this.disposal;
  }
}
