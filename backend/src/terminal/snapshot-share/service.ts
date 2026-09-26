import path from "node:path";
import type { CreateTerminalSnapshotShareResponse } from "@runweave/shared/terminal/snapshot-share";
import { getSessionOrThrow, requireTmuxSession, TerminalPanelError } from "../application/panel-common";
import { resolvePanelTarget } from "../application/panel-targets";
import type { TerminalSessionManager } from "../manager/manager";
import type { TmuxService } from "../tmux/service";
import { isTimeoutError } from "../tmux/internals";
import { TerminalSnapshotShareError } from "./errors";
import type { TerminalSnapshotPublisher } from "./publisher";

export class TerminalSnapshotShareService {
  private readonly creations = new Set<Promise<CreateTerminalSnapshotShareResponse>>();
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(
    private readonly sessions: TerminalSessionManager,
    private readonly tmuxService: TmuxService,
    private publisher?: TerminalSnapshotPublisher,
  ) {}

  replacePublisher(publisher: TerminalSnapshotPublisher | undefined): void { this.publisher = publisher; }

  create(sessionId: string, panelId: string): Promise<CreateTerminalSnapshotShareResponse> {
    if (this.disposed) return Promise.reject(new TerminalSnapshotShareError("SNAPSHOT_CAPTURE_UNAVAILABLE"));
    if (!this.publisher) return Promise.reject(new TerminalSnapshotShareError("SNAPSHOT_PUBLISH_NOT_CONFIGURED"));
    if (this.creations.size >= 4) return Promise.reject(new TerminalSnapshotShareError("SNAPSHOT_BUSY"));
    const creation = this.captureAndPublish(sessionId, panelId, this.publisher);
    this.creations.add(creation);
    void creation.finally(() => this.creations.delete(creation)).catch(() => undefined);
    return creation;
  }

  private async captureAndPublish(sessionId: string, panelId: string, publisher: TerminalSnapshotPublisher): Promise<CreateTerminalSnapshotShareResponse> {
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
    return publisher.publish(title, text);
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = Promise.allSettled([...this.creations]).then(() => undefined);
    return this.disposal;
  }
}
