import type {
  AgentTeamRun,
  AgentTeamTerminal,
  AgentTeamVerificationConfig,
  AgentTeamWorker,
  AgentTeamWorkerRole,
  RecordAgentTeamRoundRequest,
} from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import type { TerminalSessionRecord } from "../terminal/manager";
import { AgentTeamError } from "./errors";
import type { AgentTeamCompletionSignal } from "./service-types";

const DEFAULT_AGENT_TEAM_AGENT_COMMAND = "codex";

export function createSyntheticCompletionEvent(
  run: AgentTeamRun,
  session: TerminalSessionRecord,
  worker: Pick<AgentTeamWorker, "panelId" | "tmuxPaneId">,
  signal: AgentTeamCompletionSignal,
): Extract<TerminalEventEnvelope, { kind: "completion" }> {
  const now = new Date().toISOString();
  return {
    id: `agent-team-${signal.source}-${run.runId}-${Date.now()}`,
    kind: "completion",
    terminalSessionId: run.terminalSessionId,
    projectId: run.projectId,
    createdAt: now,
    payload: {
      source: "codex",
      completionReason: "manual",
      commandName: run.terminal.command ?? null,
      rawHookEvent: null,
      hookEvent: "",
      cwd: signal.cwd ?? session.cwd,
      outboxPath: signal.outboxPath ?? null,
      summary: null,
      panelId: signal.panelId ?? worker.panelId ?? null,
      tmuxPaneId: signal.tmuxPaneId ?? worker.tmuxPaneId ?? null,
    },
  };
}

export function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isStaleExpectedRound(
  run: AgentTeamRun,
  expectedRound: number | undefined,
): boolean {
  return expectedRound !== undefined && expectedRound !== run.loop.round;
}

export function isManualFeedbackRound(
  input: RecordAgentTeamRoundRequest,
): boolean {
  const results = input.acceptanceResults;
  return (
    Boolean(results?.length) &&
    results!.every((result) =>
      result.evidence.some(
        (evidence) =>
          evidence.type === "text" &&
          (evidence.ref === "manual: progress" ||
            evidence.ref === "manual: no-progress"),
      ),
    )
  );
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveAgentTeamTerminal(
  terminal: AgentTeamTerminal | undefined,
): AgentTeamTerminal {
  return {
    command: terminal?.command?.trim() || DEFAULT_AGENT_TEAM_AGENT_COMMAND,
    args: terminal?.args ?? [],
    cwd: terminal?.cwd?.trim() || null,
    runtimePreference: terminal?.runtimePreference ?? "auto",
  };
}

export function requireRunnableTask(task: string | undefined): string {
  const trimmed = task?.trim() ?? "";
  if (!trimmed) {
    throw new AgentTeamError(
      400,
      "Agent-team task is required before starting workers",
    );
  }
  return trimmed;
}

export function requireVerificationConfig(
  verification: AgentTeamVerificationConfig | null | undefined,
): AgentTeamVerificationConfig {
  if (!verification) {
    throw new AgentTeamError(
      400,
      "缺少验收来源配置，无法进入 Agent Team worker split",
    );
  }
  return verification;
}

export function formatVerificationSource(
  verification: AgentTeamVerificationConfig,
): string {
  const sourceLabel =
    verification.acceptanceSource === "test_case_file"
      ? "来源：测试案例文件"
      : verification.acceptanceSource === "plan_file_generated"
        ? "来源：计划文件生成"
        : "来源：任务描述生成";
  const sourcePath =
    verification.testCaseFilePath ??
    verification.generatedTestCaseFilePath ??
    verification.planFilePath ??
    "等待生成 docs/testing 测试案例文件";
  return `${sourceLabel} ${sourcePath}`;
}

export function assertGeneratedTestCaseFilePath(relativePath: string): void {
  if (
    !relativePath.startsWith("docs/testing/") ||
    !relativePath.endsWith("-test-cases.md")
  ) {
    throw new AgentTeamError(
      400,
      `生成的测试案例文件必须位于 docs/testing/ 且以 -test-cases.md 结尾：${relativePath}`,
    );
  }
}

export function createAgentTeamPanelError(
  runId: string,
  role: AgentTeamWorkerRole,
  error: unknown,
): AgentTeamError {
  const message = error instanceof Error ? error.message : String(error);
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : 409;
  return new AgentTeamError(
    statusCode,
    `Could not split worker pane for role "${role}": ${message}`,
    { runId, role },
  );
}
