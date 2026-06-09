import type { TerminalMobileOverviewResponse } from "@browser-viewer/shared";
import path from "node:path";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import { readTerminalScrollbackCapture } from "../terminal/runtime-launcher";
import {
  isCodexSession,
  type TerminalStateService,
} from "../terminal/terminal-state-service";
import type { TmuxService } from "../terminal/tmux-service";
import { toProjectPayload, toSessionListItem } from "./terminal-route-payloads";

const MOBILE_TERMINAL_OVERVIEW_TAIL_LINES = 80;
const MOBILE_TERMINAL_OVERVIEW_TAIL_TIMEOUT_MS = 1_500;
const terminalLogger = logger.child({ component: "terminal" });

interface MobileOverviewTailCapture {
  data: string;
  sourceCols?: number;
  error?: string;
}

export interface TerminalMobileOverviewOptions {
  includeTail?: boolean;
  terminalStateService?: TerminalStateService;
}

function tailScrollbackLines(scrollback: string, maxLines: number): string {
  const lines = scrollback.replace(/\r/g, "").split("\n");
  return lines
    .slice(Math.max(0, lines.length - maxLines))
    .join("\n")
    .trimEnd();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function basename(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized || value;
}

function buildSessionTitle(
  session: ReturnType<TerminalSessionManager["listSessions"]>[number],
): string {
  const commandLabel = isCodexSession(session)
    ? "codex"
    : session.activeCommand?.trim() || basename(session.command);
  const directoryLabel = basename(session.cwd);
  return directoryLabel ? `${commandLabel} · ${directoryLabel}` : commandLabel;
}

function buildDisplayStatus(
  session: ReturnType<TerminalSessionManager["listSessions"]>[number],
  terminalStateService?: TerminalStateService,
): {
  displayStatus: "running" | "idle" | "exited";
  displayStatusLabel: "Running" | "Idle" | "Exited";
} {
  if (session.status === "exited") {
    return { displayStatus: "exited", displayStatusLabel: "Exited" };
  }

  const terminalState = terminalStateService?.getCurrent(session.id, session);
  if (terminalState?.state === "agent_running") {
    return { displayStatus: "running", displayStatusLabel: "Running" };
  }

  return { displayStatus: "idle", displayStatusLabel: "Idle" };
}

function sortSessionsForMobileOverview(
  sessions: ReturnType<TerminalSessionManager["listSessions"]>,
): ReturnType<TerminalSessionManager["listSessions"]> {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => {
      const activityDelta =
        right.session.lastActivityAt.getTime() -
        left.session.lastActivityAt.getTime();
      return activityDelta || left.index - right.index;
    })
    .map((entry) => entry.session);
}

export async function buildTerminalMobileOverviewPayload(
  terminalSessionManager: TerminalSessionManager,
  tmuxService?: TmuxService,
  options?: TerminalMobileOverviewOptions,
): Promise<TerminalMobileOverviewResponse> {
  const includeTail = options?.includeTail ?? true;
  const sessions = sortSessionsForMobileOverview(
    terminalSessionManager.listSessions(),
  );
  return {
    projects: terminalSessionManager
      .listProjects()
      .map((project) => toProjectPayload(project)),
    sessions: await Promise.all(
      sessions.map(async (session) => {
        const basePayload = {
          ...toSessionListItem(session),
          title: buildSessionTitle(session),
          subtitle: session.cwd,
          ...buildDisplayStatus(session, options?.terminalStateService),
        };
        if (!includeTail) {
          return basePayload;
        }

        const tailCapturePromise = readTerminalScrollbackCapture(
          session,
          terminalSessionManager,
          tmuxService,
          "live",
          MOBILE_TERMINAL_OVERVIEW_TAIL_LINES,
        );
        tailCapturePromise.catch(() => undefined);

        const tailCapture: MobileOverviewTailCapture = await withTimeout(
          tailCapturePromise,
          MOBILE_TERMINAL_OVERVIEW_TAIL_TIMEOUT_MS,
          "Terminal mobile overview tail read timed out",
        ).catch((error: unknown) => {
          terminalLogger.error("terminal.mobile-overview.tail-read.failed", {
            message: "Terminal mobile overview tail read failed",
            terminalSessionId: session.id,
            error,
          });
          return {
            data: "",
            error: String(error),
          };
        });

        return {
          ...basePayload,
          tailScrollback: tailScrollbackLines(
            tailCapture.data,
            MOBILE_TERMINAL_OVERVIEW_TAIL_LINES,
          ),
          ...(tailCapture.sourceCols
            ? { tailScrollbackSourceCols: tailCapture.sourceCols }
            : {}),
          ...(tailCapture.error ? { tailError: tailCapture.error } : {}),
        };
      }),
    ),
  };
}
