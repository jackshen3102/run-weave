import {
  TERMINAL_CLIENT_SCROLLBACK_LINES,
  TERMINAL_LIVE_SCROLLBACK_BYTES,
} from "@runweave/shared/terminal-limits";
import {
  appendToScrollbackBuffer,
  captureScrollbackBufferCursor,
  createScrollbackBuffer,
  readScrollbackBuffer,
  readScrollbackBufferSince,
  readScrollbackBufferTailLines,
} from "./scrollback-buffer";
import type { RuntimeTerminalSessionRecord } from "./manager-records";
import { TerminalManagerBase } from "./manager-base";

const SCROLLBACK_FLUSH_DELAY_MS = 250;
const ACTIVITY_FLUSH_DELAY_MS = 10_000;

export class TerminalManagerBufferRuntime extends TerminalManagerBase {
  getScrollback(terminalSessionId: string): string {
    const session = this.sessions.get(terminalSessionId);
    if (!session?.scrollbackLoaded) {
      return "";
    }

    return session.scrollback;
  }

  async readScrollback(terminalSessionId: string): Promise<string> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return "";
    }

    if (!session.scrollbackLoaded) {
      await this.flushScrollback(terminalSessionId);
      session.scrollbackBuffer = createScrollbackBuffer(
        await this.sessionStore.readSessionScrollback(terminalSessionId),
      );
      session.scrollbackLoaded = true;
    }

    return session.scrollback;
  }

  getLiveScrollback(terminalSessionId: string): string {
    const session = this.sessions.get(terminalSessionId);
    if (!session?.scrollbackLoaded) {
      return "";
    }

    return readScrollbackBuffer(
      createScrollbackBuffer(
        readScrollbackBufferTailLines(
          session.scrollbackBuffer,
          TERMINAL_CLIENT_SCROLLBACK_LINES,
        ),
        TERMINAL_LIVE_SCROLLBACK_BYTES,
      ),
    );
  }

  async readLiveScrollback(terminalSessionId: string): Promise<string> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return "";
    }

    if (!session.scrollbackLoaded) {
      await this.flushScrollback(terminalSessionId);
      return this.sessionStore.readSessionLiveScrollback(terminalSessionId);
    }

    return this.getLiveScrollback(terminalSessionId);
  }

  async captureOutputCursor(terminalSessionId: string): Promise<number | null> {
    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return null;
    }
    await this.readScrollback(terminalSessionId);
    return captureScrollbackBufferCursor(session.scrollbackBuffer);
  }

  readOutputSince(terminalSessionId: string, cursor: number): string | null {
    const session = this.sessions.get(terminalSessionId);
    if (!session?.scrollbackLoaded) {
      return null;
    }
    return readScrollbackBufferSince(session.scrollbackBuffer, cursor);
  }

  appendOutput(terminalSessionId: string, chunk: string): void {
    if (!chunk) {
      return;
    }

    const session = this.sessions.get(terminalSessionId);
    if (!session) {
      return;
    }

    let bellCount = 0;
    let bellIndex = chunk.indexOf("\u0007");
    while (bellIndex >= 0) {
      bellCount += 1;
      bellIndex = chunk.indexOf("\u0007", bellIndex + 1);
    }
    if (bellCount !== 0) {
      this.observer.onBell?.({
        terminalSessionId,
        projectId: session.projectId,
        count: bellCount,
      });
    }

    appendToScrollbackBuffer(session.scrollbackBuffer, chunk);
    this.touchSessionActivity(session, "deferred");
    const pendingChunks = this.pendingScrollbackChunks.get(terminalSessionId);
    if (pendingChunks) {
      pendingChunks.push(chunk);
    } else {
      this.pendingScrollbackChunks.set(terminalSessionId, [chunk]);
    }
    this.scheduleScrollbackFlush(terminalSessionId);
  }

  async dispose(): Promise<void> {
    await this.flushAllPendingScrollback();
    await this.flushAllPendingActivity();
    await this.sessionStore.dispose();
  }

  protected touchSessionActivity(
    session: RuntimeTerminalSessionRecord,
    persistence: "deferred" | "immediate",
  ): Date {
    const lastActivityAt = new Date();
    session.lastActivityAt = lastActivityAt;
    if (persistence === "immediate") {
      this.clearPendingActivityFlush(session.id);
      this.pendingActivityUpdates.delete(session.id);
      return lastActivityAt;
    }
    this.pendingActivityUpdates.set(session.id, lastActivityAt);
    this.scheduleActivityFlush(session.id);
    return lastActivityAt;
  }

  private scheduleActivityFlush(terminalSessionId: string): void {
    this.clearPendingActivityFlush(terminalSessionId);

    const timer = setTimeout(() => {
      this.activityFlushTimers.delete(terminalSessionId);
      void this.flushActivity(terminalSessionId);
    }, ACTIVITY_FLUSH_DELAY_MS);
    this.activityFlushTimers.set(terminalSessionId, timer);
  }

  protected clearPendingActivityFlush(terminalSessionId: string): void {
    const timer = this.activityFlushTimers.get(terminalSessionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.activityFlushTimers.delete(terminalSessionId);
  }

  private async flushActivity(terminalSessionId: string): Promise<void> {
    if (!this.sessions.has(terminalSessionId)) {
      this.pendingActivityUpdates.delete(terminalSessionId);
      return;
    }

    const lastActivityAt = this.pendingActivityUpdates.get(terminalSessionId);
    if (!lastActivityAt) {
      return;
    }
    this.pendingActivityUpdates.delete(terminalSessionId);

    await this.sessionStore.updateSessionActivity({
      terminalSessionId,
      lastActivityAt: lastActivityAt.toISOString(),
    });
  }

  private scheduleScrollbackFlush(terminalSessionId: string): void {
    this.clearPendingScrollbackFlush(terminalSessionId);

    const timer = setTimeout(() => {
      this.scrollbackFlushTimers.delete(terminalSessionId);
      void this.flushScrollback(terminalSessionId);
    }, SCROLLBACK_FLUSH_DELAY_MS);
    this.scrollbackFlushTimers.set(terminalSessionId, timer);
  }

  protected clearPendingScrollbackFlush(terminalSessionId: string): void {
    const timer = this.scrollbackFlushTimers.get(terminalSessionId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.scrollbackFlushTimers.delete(terminalSessionId);
  }

  protected async flushScrollback(terminalSessionId: string): Promise<void> {
    if (!this.sessions.has(terminalSessionId)) {
      this.pendingScrollbackChunks.delete(terminalSessionId);
      return;
    }

    const pendingChunks = this.pendingScrollbackChunks.get(terminalSessionId);
    if (!pendingChunks?.length) {
      return;
    }
    this.pendingScrollbackChunks.delete(terminalSessionId);

    await this.sessionStore.appendSessionScrollback({
      terminalSessionId,
      chunk: pendingChunks.join(""),
    });
  }

  private async flushAllPendingScrollback(): Promise<void> {
    const pendingSessionIds = Array.from(this.scrollbackFlushTimers.keys());
    pendingSessionIds.forEach((terminalSessionId) =>
      this.clearPendingScrollbackFlush(terminalSessionId),
    );
    await Promise.all(
      pendingSessionIds.map((terminalSessionId) =>
        this.flushScrollback(terminalSessionId),
      ),
    );
  }

  private async flushAllPendingActivity(): Promise<void> {
    const pendingSessionIds = Array.from(this.activityFlushTimers.keys());
    pendingSessionIds.forEach((terminalSessionId) =>
      this.clearPendingActivityFlush(terminalSessionId),
    );
    await Promise.all(
      pendingSessionIds.map((terminalSessionId) =>
        this.flushActivity(terminalSessionId),
      ),
    );
  }
}
