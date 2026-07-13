import { aiDiagnosticLog } from "../diagnostic-logs/recorder";
import { logTerminalPerf } from "./perf-logging";
import type {
  TmuxKeySequenceItem,
  TmuxPaneInfo,
  TmuxPaneMetadata,
  TmuxPaneTarget,
  TmuxTarget,
} from "./tmux-types";
import { TmuxSessionService } from "./tmux-session-service";
import {
  CaptureHistoryLines,
  InteractivePaneReadyMinWaitMs,
  InteractivePaneReadyStableMs,
  InteractivePaneReadyTimeoutMs,
  TMUX_METADATA_FIELD_SEPARATOR,
  delay,
  delayAfterTmuxKey,
  describeTmuxInputChunk,
  formatShellCommand,
  normalizePaneCommand,
  parseNonNegativeInteger,
  parsePositiveInteger,
  resolvePaneActiveCommand,
  resolveTmuxTargetName,
  shellQuote,
  splitInputForSendKeys,
  tmuxLogger,
} from "./tmux-internals";

export class TmuxPaneService extends TmuxSessionService {
  async listPanes(target: TmuxTarget): Promise<TmuxPaneInfo[]> {
    const result = await this.runTmux(
      [
        "list-panes",
        "-t",
        target.sessionName,
        "-F",
        [
          "#{pane_id}",
          "#{pane_index}",
          "#{pane_current_path}",
          "#{@runweave_command}",
          "#{pane_current_command}",
          "#{pane_active}",
          "#{pane_left}",
          "#{pane_top}",
          "#{pane_width}",
          "#{pane_height}",
          "#{window_width}",
          "#{window_height}",
        ].join(TMUX_METADATA_FIELD_SEPARATOR),
      ],
      target,
    );
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const [
          paneId = "",
          rawPaneIndex = "0",
          cwd = "",
          rawRunweaveCommand = "",
          rawCommand = "",
          rawActive = "0",
          rawPaneLeft = "0",
          rawPaneTop = "0",
          rawPaneWidth = "0",
          rawPaneHeight = "0",
          rawWindowWidth = "0",
          rawWindowHeight = "0",
        ] = line.split(TMUX_METADATA_FIELD_SEPARATOR);
        const activeCommand = resolvePaneActiveCommand(
          rawRunweaveCommand,
          rawCommand,
        );
        return {
          paneId,
          paneIndex: parsePositiveInteger(rawPaneIndex),
          cwd,
          activeCommand: activeCommand.command,
          activeCommandSource: activeCommand.source,
          paneCommand: normalizePaneCommand(rawCommand),
          active: rawActive === "1",
          paneLeft: parseNonNegativeInteger(rawPaneLeft),
          paneTop: parseNonNegativeInteger(rawPaneTop),
          paneWidth: parseNonNegativeInteger(rawPaneWidth),
          paneHeight: parseNonNegativeInteger(rawPaneHeight),
          windowWidth: parseNonNegativeInteger(rawWindowWidth),
          windowHeight: parseNonNegativeInteger(rawWindowHeight),
        };
      })
      .filter((pane) => pane.paneId.startsWith("%") && pane.cwd);
  }

  async splitPane(
    target: TmuxPaneTarget,
    params: {
      direction: "right" | "down";
      cwd: string;
      command?: string;
      args?: string[];
      env?: Record<string, string | undefined>;
    },
  ): Promise<TmuxPaneTarget> {
    const result = await this.runTmux(
      [
        "split-window",
        params.direction === "right" ? "-h" : "-v",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        target.paneId,
        "-c",
        params.cwd,
        ...(params.command
          ? [
              formatShellCommand({
                command: params.command,
                args: params.args ?? [],
                env: params.env,
              }),
            ]
          : []),
      ],
      target,
    );
    const paneId = result.stdout.trim();
    if (!paneId.startsWith("%")) {
      throw new Error(`tmux split did not return a pane id: ${paneId}`);
    }
    return {
      sessionName: target.sessionName,
      socketPath: target.socketPath,
      paneId,
    };
  }

  async readSelectedPane(target: TmuxTarget): Promise<string | null> {
    try {
      const result = await this.runTmux(
        ["display-message", "-p", "-t", target.sessionName, "#{pane_id}"],
        target,
      );
      const paneId = result.stdout.trim();
      return paneId.startsWith("%") ? paneId : null;
    } catch {
      return null;
    }
  }

  async selectPane(target: TmuxPaneTarget): Promise<void> {
    await this.runTmux(["select-pane", "-t", target.paneId], target);
  }

  async killPane(target: TmuxPaneTarget): Promise<void> {
    await this.runTmux(["kill-pane", "-t", target.paneId], target);
  }

  /**
   * Nudge a pane's shared divider by `cells` cells. `-R`/`-L` grow/shrink the
   * target pane's right edge (vertical divider) and `-D`/`-U` its bottom edge
   * (horizontal divider) - the dividers the frontend resize handles drag in a
   * main-vertical layout.
   */
  async resizePane(
    target: TmuxPaneTarget,
    params: { direction: "left" | "right" | "up" | "down"; cells: number },
  ): Promise<void> {
    const cells = Math.trunc(params.cells);
    if (cells <= 0) {
      return;
    }
    const resizeFlag = {
      right: "-R",
      left: "-L",
      down: "-D",
      up: "-U",
    }[params.direction];
    await this.runTmux(
      ["resize-pane", "-t", target.paneId, resizeFlag, String(cells)],
      target,
    );
  }

  /**
   * Normalize a window into a main-vertical layout: the main pane (index 0)
   * on the left at `mainPaneWidthPercent`, remaining panes stacked evenly on
   * the right. Used after agent-team worker splits so the main terminal keeps
   * a stable 50% width instead of the uneven residue left by sequential splits.
   */
  async applyMainVerticalLayout(
    target: TmuxTarget,
    mainPaneWidthPercent = 50,
  ): Promise<void> {
    await this.runTmux(
      [
        "set-window-option",
        "-t",
        target.sessionName,
        "main-pane-width",
        `${mainPaneWidthPercent}%`,
      ],
      target,
    );
    await this.runTmux(
      ["select-layout", "-t", target.sessionName, "main-vertical"],
      target,
    );
  }

  async sendInput(
    target: TmuxTarget | TmuxPaneTarget,
    data: string,
  ): Promise<void> {
    const chunks = splitInputForSendKeys(data);
    const tmuxTarget = resolveTmuxTargetName(target);
    aiDiagnosticLog("terminal tmux send-input started", {
      tmuxSessionName: target.sessionName,
      socketPath: target.socketPath,
      tmuxTarget,
      chunkCount: chunks.length,
      inputByteLength: Buffer.byteLength(data, "utf8"),
      inputCharLength: data.length,
      isEscapeOnly: data === "\u001b",
    });
    for (const chunk of chunks) {
      if (chunk.type === "enter") {
        aiDiagnosticLog("terminal tmux send-key", {
          tmuxSessionName: target.sessionName,
          keyMode: "key",
          key: "Enter",
          chunk: describeTmuxInputChunk(chunk),
        });
        await this.runTmux(["send-keys", "-t", tmuxTarget, "Enter"], target);
        continue;
      }
      if (chunk.value) {
        aiDiagnosticLog("terminal tmux send-key", {
          tmuxSessionName: target.sessionName,
          keyMode: "literal",
          chunk: describeTmuxInputChunk(chunk),
        });
        await this.runTmux(
          ["send-keys", "-t", tmuxTarget, "-l", "--", chunk.value],
          target,
        );
      }
    }
  }

  async sendKeySequence(
    target: TmuxTarget | TmuxPaneTarget,
    sequence: TmuxKeySequenceItem[],
  ): Promise<void> {
    const tmuxTarget = resolveTmuxTargetName(target);
    aiDiagnosticLog("terminal tmux send-key-sequence started", {
      tmuxSessionName: target.sessionName,
      socketPath: target.socketPath,
      tmuxTarget,
      itemCount: sequence.length,
    });
    for (const item of sequence) {
      if (item.type === "key") {
        aiDiagnosticLog("terminal tmux send-key", {
          tmuxSessionName: target.sessionName,
          keyMode: "key",
          key: item.key,
        });
        await this.runTmux(["send-keys", "-t", tmuxTarget, item.key], target);
        await delayAfterTmuxKey(item.delayAfterMs);
        continue;
      }
      if (item.value) {
        aiDiagnosticLog("terminal tmux send-key", {
          tmuxSessionName: target.sessionName,
          keyMode: "literal",
          chunk: describeTmuxInputChunk({
            type: "text",
            value: item.value,
          }),
        });
        await this.runTmux(
          ["send-keys", "-t", tmuxTarget, "-l", "--", item.value],
          target,
        );
      }
      await delayAfterTmuxKey(item.delayAfterMs);
    }
  }

  async cancelCopyMode(target: TmuxTarget | TmuxPaneTarget): Promise<void> {
    const tmuxTarget = resolveTmuxTargetName(target);
    aiDiagnosticLog("terminal tmux cancel-copy-mode requested", {
      tmuxSessionName: target.sessionName,
      socketPath: target.socketPath,
      tmuxTarget,
    });
    try {
      await this.runTmux(
        ["send-keys", "-t", tmuxTarget, "-X", "cancel"],
        target,
      );
    } catch (error) {
      if (
        /not in a mode/i.test(
          error instanceof Error ? error.message : String(error),
        )
      ) {
        return;
      }
      tmuxLogger.warn("terminal.tmux.cancel-copy-mode.failed", {
        message: "Failed to cancel tmux copy mode",
        sessionName: target.sessionName,
        socketPath: target.socketPath,
        tmuxTarget,
        error,
      });
    }
  }

  async capturePane(
    target: TmuxTarget | TmuxPaneTarget,
    historyLines = CaptureHistoryLines,
  ): Promise<{ data: string; durationMs: number; sourceCols?: number }> {
    const startedAt = performance.now();
    const tmuxTarget = resolveTmuxTargetName(target);
    const [result, sourceCols] = await Promise.all([
      this.runTmux(
        [
          "capture-pane",
          "-p",
          "-J",
          "-S",
          `-${historyLines}`,
          "-t",
          tmuxTarget,
        ],
        target,
      ),
      this.readPaneWidth(target),
    ]);
    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    logTerminalPerf("terminal.tmux.capture-pane", {
      sessionName: target.sessionName,
      durationMs,
      historyLines,
      sourceCols,
      bytes: Buffer.byteLength(result.stdout, "utf8"),
    });
    return {
      data: result.stdout,
      durationMs,
      sourceCols,
    };
  }

  async readPaneMetadata(
    target: TmuxTarget | TmuxPaneTarget,
    shellCommand?: string,
  ): Promise<TmuxPaneMetadata | null> {
    const tmuxTarget = resolveTmuxTargetName(target);
    const result = await this.runTmux(
      [
        "display-message",
        "-p",
        "-t",
        tmuxTarget,
        [
          "#{pane_current_path}",
          "#{@runweave_command}",
          "#{pane_current_command}",
        ].join(TMUX_METADATA_FIELD_SEPARATOR),
      ],
      target,
    );
    const [rawCwd = "", rawRunweaveCommand = "", rawCommand = ""] =
      result.stdout.replace(/\r?\n$/, "").split(TMUX_METADATA_FIELD_SEPARATOR);
    const cwd = rawCwd.trim();
    if (!cwd) {
      return null;
    }
    const activeCommand = resolvePaneActiveCommand(
      rawRunweaveCommand,
      rawCommand,
      shellCommand,
    );
    return {
      cwd,
      activeCommand: activeCommand.command,
      activeCommandSource: activeCommand.source,
      paneCommand: normalizePaneCommand(rawCommand),
    };
  }

  async pipePaneOutput(target: TmuxTarget, outputPath: string): Promise<void> {
    await this.runTmux(
      [
        "pipe-pane",
        "-t",
        target.sessionName,
        `cat >> ${shellQuote(outputPath)}`,
      ],
      target,
    );
  }

  async stopPaneOutputPipe(target: TmuxTarget): Promise<void> {
    await this.runTmux(["pipe-pane", "-t", target.sessionName], target);
  }

  private async readPaneWidth(
    target: TmuxTarget | TmuxPaneTarget,
  ): Promise<number | undefined> {
    try {
      const tmuxTarget = resolveTmuxTargetName(target);
      const result = await this.runTmux(
        ["display-message", "-p", "-t", tmuxTarget, "#{pane_width}"],
        target,
      );
      const width = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(width) && width > 0 ? width : undefined;
    } catch {
      return undefined;
    }
  }

  async waitForPaneReady(target: TmuxTarget): Promise<void> {
    const startedAt = Date.now();
    let lastCapture = "";
    let stableSince = 0;

    while (Date.now() - startedAt < InteractivePaneReadyTimeoutMs) {
      try {
        const capture = await this.capturePane(target, 80);
        const currentCapture = capture.data.trimEnd();
        if (currentCapture && currentCapture === lastCapture) {
          if (stableSince === 0) {
            stableSince = Date.now();
          }
          if (
            Date.now() - startedAt >= InteractivePaneReadyMinWaitMs &&
            Date.now() - stableSince >= InteractivePaneReadyStableMs
          ) {
            return;
          }
        } else {
          lastCapture = currentCapture;
          stableSince = 0;
        }
      } catch {
        stableSince = 0;
      }
      await delay(100);
    }
    tmuxLogger.warn("terminal.tmux.wait-pane-ready.timeout", {
      message: "Tmux pane ready wait timed out",
      sessionName: target.sessionName,
      socketPath: target.socketPath,
      timeoutMs: InteractivePaneReadyTimeoutMs,
    });
  }
}
