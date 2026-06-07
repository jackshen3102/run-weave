import type {
  TerminalMobileOverviewSession,
  TerminalProjectListItem,
} from "@browser-viewer/shared";
import {
  inferTerminalState,
  stripTerminalControlSequences,
  type InferredWorkloadState,
  type StatusColor,
} from "./terminal-state";

export interface MobileTerminalCardViewModel {
  terminalSessionId: string;
  shortId: string;
  projectId: string;
  projectName: string;
  cwd: string | null;
  tmuxSessionName: string | null;
  tmuxSocketPath: string | null;
  sessionStatus: "running" | "stopped" | "exited";
  foregroundCommand: string | null;
  inferredWorkloadState: InferredWorkloadState;
  statusLabel: string;
  statusColor: StatusColor;
  lastOutputAt: string | null;
  tailChangedRecently: boolean;
  promptDetected: boolean;
  confidence: number;
  stateReason: string[];
  tailPreview: string;
  primaryAction: "send_to_hermes" | "observe" | "run_command" | "summarize";
  createdAt: string;
  historyStatus: "loaded" | "error";
  historyError: string | null;
}

export interface ProjectMobileSummary {
  projectId: string;
  name: string;
  path: string | null;
  totalTerminals: number;
  needsAttention: number;
  runningAgents: number;
  idleShells: number;
}

const PROMPT_PATTERN = /(^|\n)\s*[›>]\s+|(?:^|\n).*(?:[%$#]\s*)$/;

function buildFallbackTmuxSessionName(terminalSessionId: string): string {
  return `runweave-${terminalSessionId}`;
}

function resolveTmuxSessionName(params: {
  terminalSessionId: string;
  sessionName?: string;
  socketPath?: string;
}): string | null {
  if (params.sessionName) {
    return params.sessionName;
  }
  if (params.socketPath) {
    return buildFallbackTmuxSessionName(params.terminalSessionId);
  }
  return null;
}

export function tailLines(scrollback: string, maxLines: number): string {
  const lines = scrollback.replace(/\r/g, "").split("\n");
  return lines
    .slice(Math.max(0, lines.length - maxLines))
    .join("\n")
    .trimEnd();
}

export function buildMobileTerminalCards(params: {
  projects: TerminalProjectListItem[];
  sessions: TerminalMobileOverviewSession[];
  changedSessionIds: Set<string>;
}): MobileTerminalCardViewModel[] {
  const projectById = new Map(
    params.projects.map((project) => [project.projectId, project]),
  );

  return params.sessions.map((session) => {
    const project = projectById.get(session.projectId);
    const tmuxSocketPath = session.tmuxSocketPath;
    const tmuxSessionName = resolveTmuxSessionName({
      terminalSessionId: session.terminalSessionId,
      sessionName: session.tmuxSessionName,
      socketPath: tmuxSocketPath,
    });
    if (session.tailError) {
      return {
        terminalSessionId: session.terminalSessionId,
        shortId: session.terminalSessionId.slice(0, 8),
        projectId: session.projectId,
        projectName: project?.name ?? "Unknown project",
        cwd: session.cwd ?? project?.path ?? null,
        tmuxSessionName,
        tmuxSocketPath: tmuxSocketPath ?? null,
        sessionStatus: session.status,
        foregroundCommand: session.activeCommand ?? session.command,
        inferredWorkloadState: "history_unavailable",
        statusLabel: "状态不可用",
        statusColor: "gray",
        lastOutputAt: null,
        tailChangedRecently: false,
        promptDetected: false,
        confidence: 0.1,
        stateReason: ["读取最近输出失败，未进行状态推断", session.tailError],
        tailPreview: "读取最近输出失败",
        primaryAction: "observe",
        createdAt: session.createdAt,
        historyStatus: "error",
        historyError: session.tailError,
      };
    }

    const scrollback = stripTerminalControlSequences(
      session.tailScrollback ?? "",
    );
    const tailPreview = tailLines(scrollback, 80);
    const inference = inferTerminalState({
      sessionStatus: session.status,
      exitCode: session.exitCode,
      activeCommand: session.activeCommand,
      command: session.command,
      tail: tailPreview,
      tailChangedRecently: params.changedSessionIds.has(
        session.terminalSessionId,
      ),
    });

    return {
      terminalSessionId: session.terminalSessionId,
      shortId: session.terminalSessionId.slice(0, 8),
      projectId: session.projectId,
      projectName: project?.name ?? "Unknown project",
      cwd: session.cwd ?? project?.path ?? null,
      tmuxSessionName,
      tmuxSocketPath: tmuxSocketPath ?? null,
      sessionStatus: session.status,
      foregroundCommand: inference.foregroundCommand,
      inferredWorkloadState: inference.inferredWorkloadState,
      statusLabel: inference.statusLabel,
      statusColor: inference.statusColor,
      lastOutputAt: null,
      tailChangedRecently: params.changedSessionIds.has(
        session.terminalSessionId,
      ),
      promptDetected: PROMPT_PATTERN.test(tailPreview),
      confidence: inference.confidence,
      stateReason: inference.stateReason,
      tailPreview,
      primaryAction: inference.primaryAction,
      createdAt: session.createdAt,
      historyStatus: "loaded",
      historyError: null,
    };
  });
}

export function buildProjectSummaries(params: {
  projects: TerminalProjectListItem[];
  cards: MobileTerminalCardViewModel[];
}): ProjectMobileSummary[] {
  return params.projects.map((project) => {
    const projectCards = params.cards.filter(
      (card) => card.projectId === project.projectId,
    );

    return {
      projectId: project.projectId,
      name: project.name,
      path: project.path,
      totalTerminals: projectCards.length,
      needsAttention: projectCards.filter((card) =>
        ["agent_waiting_input", "failed", "possibly_stuck"].includes(
          card.inferredWorkloadState,
        ),
      ).length,
      runningAgents: projectCards.filter(
        (card) => card.inferredWorkloadState === "agent_running",
      ).length,
      idleShells: projectCards.filter(
        (card) => card.inferredWorkloadState === "idle_shell",
      ).length,
    };
  });
}

export function sortMobileTerminalCards(
  cards: MobileTerminalCardViewModel[],
): MobileTerminalCardViewModel[] {
  return [...cards].sort((left, right) => {
    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    );
  });
}
