import path from "node:path";
import type { CreateTerminalSnapshotShareResponse, TerminalSnapshotShareAccess } from "@runweave/shared/terminal/snapshot-share";
import { logger } from "../../logging/index";
import { getSessionOrThrow, requireTmuxSession, TerminalPanelError } from "../application/panel-common";
import { resolvePanelTarget } from "../application/panel-targets";
import type { TerminalSessionManager } from "../manager/manager";
import type { TmuxService } from "../tmux/service";
import { isTimeoutError } from "../tmux/internals";
import { TerminalSnapshotShareError } from "./errors";
import { TerminalSnapshotShareStore } from "./store";

export class TerminalSnapshotShareService {
  private readonly creations = new Set<Promise<CreateTerminalSnapshotShareResponse>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private maintenance: Promise<void> | null = null;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly store: TerminalSnapshotShareStore,
    private readonly sessions: TerminalSessionManager,
    private readonly tmuxService: TmuxService,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    if (this.disposed) return;
    this.timer = setInterval(() => {
      if (this.maintenance) return;
      this.maintenance = this.store.cleanup().catch(() => {
        logger.warn("terminal.snapshot-share.cleanup-failed", { code: "CLEANUP_FAILED" });
      }).finally(() => { this.maintenance = null; });
    }, 60_000);
    this.timer.unref();
  }

  read(access: TerminalSnapshotShareAccess) {
    return this.store.read(access);
  }

  create(sessionId: string, panelId: string): Promise<CreateTerminalSnapshotShareResponse> {
    if (this.disposed) return Promise.reject(new TerminalSnapshotShareError("SNAPSHOT_CAPTURE_UNAVAILABLE"));
    if (this.creations.size >= 4) return Promise.reject(new TerminalSnapshotShareError("SNAPSHOT_BUSY"));
    const creation = this.captureAndSave(sessionId, panelId);
    this.creations.add(creation);
    void creation.finally(() => this.creations.delete(creation)).catch(() => undefined);
    return creation;
  }

  private async captureAndSave(sessionId: string, panelId: string): Promise<CreateTerminalSnapshotShareResponse> {
    let title: string;
    let text: string;
    try {
      if (!panelId) throw new TerminalSnapshotShareError("SNAPSHOT_TARGET_NOT_FOUND");
      const session = getSessionOrThrow(this.sessions, sessionId);
      const tmux = requireTmuxSession(session, this.tmuxService);
      if (!(await tmux.isAvailable())) throw new TerminalSnapshotShareError("SNAPSHOT_CAPTURE_UNAVAILABLE");
      const { panel, paneTarget } = await resolvePanelTarget(
        this.sessions, session, { tmuxService: tmux }, { panelId }, "explicit-or-active",
      );
      const sessionLabel = session.alias?.trim() || path.basename(session.cwd) || "Terminal";
      title = `${sessionLabel.slice(0, 160)} · ${(panel.alias || panel.id).slice(0, 72)}`;
      text = await tmux.capturePaneSnapshot(paneTarget);
    } catch (error) {
      if (error instanceof TerminalSnapshotShareError) throw error;
      if (error instanceof TerminalPanelError) {
        throw new TerminalSnapshotShareError(error.statusCode === 404 ? "SNAPSHOT_TARGET_NOT_FOUND"
          : error.statusCode === 503 ? "SNAPSHOT_CAPTURE_UNAVAILABLE" : "SNAPSHOT_TARGET_UNAVAILABLE");
      }
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      throw new TerminalSnapshotShareError(code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "SNAPSHOT_TOO_LARGE"
        : code === "ENOENT" || isTimeoutError(error) ? "SNAPSHOT_CAPTURE_UNAVAILABLE" : "SNAPSHOT_TARGET_UNAVAILABLE");
    }
    try {
      return await this.store.save(title, text);
    } catch (error) {
      if (error instanceof TerminalSnapshotShareError) throw error;
      logger.warn("terminal.snapshot-share.save-failed", { code: "SNAPSHOT_STORAGE_FAILED" });
      throw new TerminalSnapshotShareError("SNAPSHOT_STORAGE_FAILED");
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.disposal = Promise.allSettled([...this.creations, ...(this.maintenance ? [this.maintenance] : [])]).then(() => undefined);
    return this.disposal;
  }
}
