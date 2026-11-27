import type {
  TerminalWaitOutputRequest,
  TerminalWaitOutputResponse,
} from "@runweave/shared/terminal/wait";
import type { TerminalSessionManager } from "../manager/manager";
import { isTmuxBackedSession } from "../runtime/launcher";
import type { TerminalEventService } from "../state/terminal-event-service";
import type { TmuxService } from "../tmux/service";
import { resolvePanelTarget } from "./panel-targets";

export const DEFAULT_WAIT_OUTPUT_TIMEOUT_MS = 60_000;
export const DEFAULT_WAIT_OUTPUT_LINES = 120;
const OUTPUT_POLL_INTERVAL_MS = 250;

export function sliceTailLines(value: string, lineCount: number): string {
  if (lineCount <= 0) {
    return "";
  }
  const lines = value.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return lines.slice(-lineCount).join("\n");
}

export function waitForWakeOrDeadline(params: {
  deadlineAt: number;
  intervalMs: number;
  signal?: AbortSignal;
  registerWake: (wake: () => void) => () => void;
}): Promise<void> {
  const remaining = params.deadlineAt - Date.now();
  if (remaining <= 0 || params.signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unregister();
      params.signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(
      finish,
      Math.max(1, Math.min(params.intervalMs, remaining)),
    );
    const unregister = params.registerWake(finish);
    params.signal?.addEventListener("abort", finish, { once: true });
  });
}

export async function executeWaitForOutput(params: {
  terminalSessionId: string;
  request: TerminalWaitOutputRequest;
  compiledRegex: RegExp | null;
  terminalSessionManager: TerminalSessionManager;
  tmuxService?: TmuxService;
  terminalEventService?: TerminalEventService;
  signal?: AbortSignal;
}): Promise<TerminalWaitOutputResponse> {
  const {
    terminalSessionId,
    request,
    compiledRegex,
    terminalSessionManager,
    tmuxService,
    terminalEventService,
    signal,
  } = params;
  const lines = request.lines ?? DEFAULT_WAIT_OUTPUT_LINES;
  const unwrap = request.unwrap !== false;
  const timeoutMs = request.timeoutMs ?? DEFAULT_WAIT_OUTPUT_TIMEOUT_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const captureCurrentSnapshot = async (): Promise<{
    panelId: string | null;
    snapshot: string;
  }> => {
    const currentSession =
      terminalSessionManager.getSession(terminalSessionId);
    if (!currentSession) {
      return { panelId: null, snapshot: "" };
    }
    if (
      currentSession.status === "running" &&
      isTmuxBackedSession(currentSession) &&
      tmuxService
    ) {
      const target = tmuxService.buildTarget(currentSession.id);
      if (await tmuxService.hasSession(target)) {
        const { panel, paneTarget } = await resolvePanelTarget(
          terminalSessionManager,
          currentSession,
          { tmuxService, terminalEventService },
          {
            panelId: request.panelId,
            panelAlias: request.panelAlias,
            role: request.role,
          },
          "explicit-or-active",
        );
        const captured = await tmuxService.capturePane(
          paneTarget,
          Math.max(lines, 1),
          { joinWrappedLines: unwrap },
        );
        return {
          panelId: panel.id,
          snapshot: sliceTailLines(captured.data, lines),
        };
      }
    }
    const raw = await terminalSessionManager.readScrollback(currentSession.id);
    return {
      panelId: null,
      snapshot: sliceTailLines(raw, lines),
    };
  };

  const findMatchingLine = (snapshot: string): string | null => {
    if (!snapshot) {
      return null;
    }
    const candidates = snapshot.split(/\r?\n/);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const line = candidates[index]!;
      const hit = compiledRegex
        ? compiledRegex.test(line)
        : line.includes(request.match!);
      if (hit) {
        return line;
      }
    }
    return null;
  };

  let lastCapture = await captureCurrentSnapshot();
  let matchedLine = findMatchingLine(lastCapture.snapshot);
  if (matchedLine !== null || timeoutMs <= 0) {
    return {
      terminalSessionId,
      panelId: lastCapture.panelId,
      matched: matchedLine !== null,
      matchedLine,
      snapshot: lastCapture.snapshot,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    };
  }

  while (!signal?.aborted && Date.now() < deadline) {
    await waitForWakeOrDeadline({
      deadlineAt: deadline,
      intervalMs: OUTPUT_POLL_INTERVAL_MS,
      signal,
      registerWake: () => () => {},
    });
    if (signal?.aborted) {
      break;
    }
    if (!terminalSessionManager.getSession(terminalSessionId)) {
      break;
    }
    lastCapture = await captureCurrentSnapshot();
    matchedLine = findMatchingLine(lastCapture.snapshot);
    if (matchedLine !== null) {
      return {
        terminalSessionId,
        panelId: lastCapture.panelId,
        matched: true,
        matchedLine,
        snapshot: lastCapture.snapshot,
        elapsedMs: Math.max(0, Date.now() - startedAt),
      };
    }
  }

  return {
    terminalSessionId,
    panelId: lastCapture.panelId,
    matched: false,
    matchedLine: null,
    snapshot: lastCapture.snapshot,
    elapsedMs: Math.max(0, Date.now() - startedAt),
  };
}
