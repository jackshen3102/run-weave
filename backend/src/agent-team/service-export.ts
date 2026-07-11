import { readFile, stat } from "node:fs/promises";
import type {
  AgentTeamExportHistoryMode,
  AgentTeamExportOutbox,
  AgentTeamExportPanel,
  AgentTeamExportResponse,
  AgentTeamRun,
} from "@runweave/shared/agent-team";
import type {
  TerminalPanelRecord,
  TerminalSessionRecord,
} from "../terminal/manager";
import { normalizeAgentTeamWorkerOutbox } from "./outbox-resolver";
import { AgentTeamLifecycleService } from "./service-lifecycle";
import type { ExportAgentTeamRunOptions } from "./service-types";
import {
  clampExportTailLines,
  parseWorkerRoleFromPanelRole,
} from "./service-workflow-policy";
import { buildExportAcceptanceSummary } from "./service-export-policy";
import { formatErrorMessage } from "./service-run-policy";

const MAX_EXPORT_TAIL_LINES = 5_000;

export class AgentTeamExportService extends AgentTeamLifecycleService {
  async exportRun(
    runId: string,
    options: ExportAgentTeamRunOptions = {},
  ): Promise<AgentTeamExportResponse> {
    const run = await this.requireRun(runId);
    const session = this.requireSession(run.terminalSessionId);
    const panels = this.terminalSessionManager.listPanels(
      run.terminalSessionId,
    );
    const warnings: string[] = [];
    const historyMode = options.history ?? "tail";
    const tailLines = clampExportTailLines(options.tailLines);
    const includeSessionOther = options.includeSessionOther ?? true;
    const includeOutboxes = options.includeOutboxes ?? true;
    if (historyMode === "full") {
      warnings.push(
        `history=full is capped at ${MAX_EXPORT_TAIL_LINES} lines per pane by tmux capture-pane`,
      );
    }
    const runBoundPanelIds = new Set<string>();
    if (run.mainPanelId) {
      runBoundPanelIds.add(run.mainPanelId);
    }
    for (const worker of run.workers) {
      if (worker.panelId) {
        runBoundPanelIds.add(worker.panelId);
      }
    }
    for (const panel of panels) {
      if (panel.agentTeamRunId === run.runId) {
        runBoundPanelIds.add(panel.id);
      }
      if (panel.role?.startsWith(`agent-team:${run.runId}:`)) {
        runBoundPanelIds.add(panel.id);
      }
    }

    const runBound: AgentTeamExportPanel[] = [];
    const sessionOther: AgentTeamExportPanel[] = [];
    for (const panel of panels) {
      const exportPanel = await this.buildExportPanel({
        run,
        session,
        panel,
        source: runBoundPanelIds.has(panel.id) ? "run-bound" : "session-other",
        historyMode,
        tailLines,
      });
      if (runBoundPanelIds.has(panel.id)) {
        runBound.push(exportPanel);
      } else if (includeSessionOther) {
        sessionOther.push(exportPanel);
      }
    }

    for (const panelId of runBoundPanelIds) {
      if (panels.some((panel) => panel.id === panelId)) {
        continue;
      }
      warnings.push(
        `Run-bound panel ${panelId} is not present in session workspace`,
      );
      runBound.push({
        panelId,
        tmuxPaneId: null,
        alias: null,
        role: null,
        workerRole: panelId === run.mainPanelId ? "main" : "unknown",
        workerId: null,
        source: panelId === run.mainPanelId ? "main" : "worker",
        history:
          historyMode === "none"
            ? undefined
            : {
                mode: "unavailable",
                tailLines: null,
                scrollback: null,
                error: "Panel is not present in session workspace",
              },
      });
    }

    const outboxes = includeOutboxes
      ? await this.collectExportOutboxes(run, session, runBound, warnings)
      : [];

    return {
      run,
      generatedAt: new Date().toISOString(),
      projectRoot: this.resolveProjectRoot(run.projectId, session.cwd),
      panels: { runBound, sessionOther },
      outboxes,
      acceptanceSummary: buildExportAcceptanceSummary(run, outboxes),
      warnings,
    };
  }

  // --- Phase 1: plain terminal -> flow (start run) ---

  protected async buildExportPanel(params: {
    run: AgentTeamRun;
    session: TerminalSessionRecord;
    panel: TerminalPanelRecord;
    source: "run-bound" | "session-other";
    historyMode: AgentTeamExportHistoryMode;
    tailLines: number;
  }): Promise<AgentTeamExportPanel> {
    const { run, session, panel, source, historyMode, tailLines } = params;
    const worker =
      run.workers.find((item) => item.panelId === panel.id) ?? null;
    const workerRole =
      panel.id === run.mainPanelId
        ? "main"
        : (worker?.role ?? parseWorkerRoleFromPanelRole(run.runId, panel.role));
    const exportPanel: AgentTeamExportPanel = {
      panelId: panel.id,
      tmuxPaneId: panel.tmuxPaneId ?? null,
      alias: panel.alias,
      role: panel.role,
      workerRole: workerRole ?? "unknown",
      workerId: worker?.id ?? panel.agentTeamWorkerId ?? null,
      source:
        panel.id === run.mainPanelId
          ? "main"
          : source === "run-bound"
            ? "worker"
            : "session-other",
    };
    if (historyMode === "none") {
      return exportPanel;
    }
    if (!this.tmuxService) {
      return {
        ...exportPanel,
        history: {
          mode: "unavailable",
          tailLines: null,
          scrollback: null,
          error: "tmux service is unavailable",
        },
      };
    }
    try {
      const capture = await this.tmuxService.capturePane(
        {
          ...this.tmuxService.buildTarget(session.id),
          paneId: panel.tmuxPaneId,
        },
        historyMode === "full" ? MAX_EXPORT_TAIL_LINES : tailLines,
      );
      return {
        ...exportPanel,
        history: {
          mode: historyMode === "full" ? "full" : "tail",
          tailLines: historyMode === "full" ? null : tailLines,
          scrollback: capture.data,
        },
      };
    } catch (error) {
      return {
        ...exportPanel,
        history: {
          mode: "unavailable",
          tailLines: null,
          scrollback: null,
          error: formatErrorMessage(error),
        },
      };
    }
  }

  protected async collectExportOutboxes(
    run: AgentTeamRun,
    session: TerminalSessionRecord,
    panels: AgentTeamExportPanel[],
    warnings: string[],
  ): Promise<AgentTeamExportOutbox[]> {
    const candidates: AgentTeamExportOutbox[] = [];
    const addCandidate = (
      candidate: Omit<AgentTeamExportOutbox, "exists" | "outbox">,
    ) => {
      if (candidates.some((item) => item.path === candidate.path)) {
        return;
      }
      candidates.push({ ...candidate, exists: false, outbox: null });
    };
    for (const panel of panels) {
      if (panel.panelId) {
        addCandidate({
          path: this.paths.workerOutboxPath(
            run.projectId,
            run.terminalSessionId,
            { panelId: panel.panelId },
            session.cwd,
          ),
          scope: "panel",
          panelId: panel.panelId,
          tmuxPaneId: panel.tmuxPaneId,
        });
      }
      if (panel.tmuxPaneId) {
        addCandidate({
          path: this.paths.workerOutboxPath(
            run.projectId,
            run.terminalSessionId,
            { tmuxPaneId: panel.tmuxPaneId },
            session.cwd,
          ),
          scope: "tmux-pane",
          panelId: panel.panelId,
          tmuxPaneId: panel.tmuxPaneId,
        });
      }
    }
    addCandidate({
      path: this.paths.defaultOutboxPath(
        run.projectId,
        run.terminalSessionId,
        session.cwd,
      ),
      scope: "legacy-session",
      panelId: null,
      tmuxPaneId: null,
    });

    return Promise.all(
      candidates.map(async (candidate) => {
        try {
          const raw = await readFile(candidate.path, "utf8");
          const fileStat = await stat(candidate.path);
          const outbox = normalizeAgentTeamWorkerOutbox(JSON.parse(raw), {
            terminalSessionId: run.terminalSessionId,
            projectId: run.projectId,
            panelId: candidate.panelId,
            tmuxPaneId: candidate.tmuxPaneId,
            finishedAt: fileStat.mtime.toISOString(),
          });
          if (!outbox) {
            const message = `Outbox ${candidate.path} has an invalid schema`;
            warnings.push(message);
            return {
              ...candidate,
              exists: true,
              outbox: null,
              error: message,
            };
          }
          return {
            ...candidate,
            exists: true,
            outbox,
          };
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? String((error as { code?: unknown }).code)
              : "";
          if (code !== "ENOENT") {
            warnings.push(
              `Could not read outbox ${candidate.path}: ${formatErrorMessage(error)}`,
            );
            return {
              ...candidate,
              error: formatErrorMessage(error),
            };
          }
          return candidate;
        }
      }),
    );
  }
}
