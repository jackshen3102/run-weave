import type { TerminalMobileOverviewResponse } from "@browser-viewer/shared";
import { logger } from "../logging";
import type { TerminalSessionManager } from "../terminal/manager";
import { readTerminalScrollbackCapture } from "../terminal/runtime-launcher";
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

export async function buildTerminalMobileOverviewPayload(
  terminalSessionManager: TerminalSessionManager,
  tmuxService?: TmuxService,
): Promise<TerminalMobileOverviewResponse> {
  const sessions = terminalSessionManager.listSessions();
  return {
    projects: terminalSessionManager
      .listProjects()
      .map((project) => toProjectPayload(project)),
    sessions: await Promise.all(
      sessions.map(async (session) => {
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
          ...toSessionListItem(session),
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
