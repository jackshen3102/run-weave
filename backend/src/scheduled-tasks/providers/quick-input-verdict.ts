import { randomUUID } from "node:crypto";
import { settingText } from "@runweave/config-node";
import type { ConversationMessage } from "@runweave/shared/terminal/conversation";
import type {
  PreviousSupervisionContinuation,
  SupervisionAssessment,
  SupervisionInput,
  TaskOutcome,
} from "@runweave/shared/task-supervision";
import { TaskSupervisionClassifier } from "../../task-supervision/classifier";
import {
  INPUT_BUDGET_BYTES,
  isSupervisionPrompt,
  readPlans,
  referencedPlans,
} from "../../task-supervision/context";
import { collectDeliverables } from "../../task-supervision/deliverables";
import type { ScheduledProviderRequest, ScheduledProviderResult } from "./types";

export const MAX_IN_PLACE_CONTINUATIONS = 3;
const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 90_000;

export interface QuickInputTurnVerdict {
  outcome: TaskOutcome;
  reason: string;
  guidance: {
    remainingWork: string;
    nextAction: string;
    authorizationMessageIds: string[];
    blocker: string;
    requiredUserAction: string;
  };
  assessment: Pick<SupervisionAssessment, "disposition" | "holdReason">;
}

export type QuickInputTurnClassifier = (
  input: SupervisionInput,
  options: {
    model?: string;
    effort?: string;
    timeoutMs: number;
    signal: AbortSignal;
  },
) => Promise<QuickInputTurnVerdict>;

export function createDefaultQuickInputClassifier(
  directory: string,
): QuickInputTurnClassifier {
  const classifier = new TaskSupervisionClassifier(directory);
  return (input, options) => classifier.run(input, options);
}

export type EvaluatedQuickInputTurn =
  | { kind: "complete"; result: ScheduledProviderResult }
  | {
      kind: "continue";
      decisionId: string;
      followUpPrompt: string;
      nextPreviousContinuation: PreviousSupervisionContinuation;
    }
  | { kind: "retain"; result: ScheduledProviderResult };

export async function evaluateQuickInputTurn(params: {
  classify: QuickInputTurnClassifier;
  request: ScheduledProviderRequest;
  threadId: string;
  turns: Array<{ id?: string; messages: ConversationMessage[] }>;
  finalMessage: ConversationMessage;
  rawTurnId: string;
  continuations: number;
  previousContinuation?: PreviousSupervisionContinuation;
  hasPendingUserInput: boolean;
  deadlineAt: number;
  signal: AbortSignal;
  checkCancelled: () => void;
}): Promise<EvaluatedQuickInputTurn> {
  const supervisionInput = await buildSupervisionInputForTurn({
    prompt: params.request.prompt,
    runId: params.request.runId,
    workingDirectory: params.request.workingDirectory,
    turns: params.turns,
    finalMessage: params.finalMessage,
    rawTurnId: params.rawTurnId,
    previousContinuation: params.previousContinuation,
    signal: params.signal,
  });
  const remainingMs = Math.max(1_000, params.deadlineAt - Date.now());
  const configured = Number(
    settingText("backend.taskSupervision.classificationTimeoutMs"),
  );
  const timeoutMs = Math.min(
    remainingMs,
    Number.isSafeInteger(configured) && configured > 0
      ? configured
      : DEFAULT_CLASSIFICATION_TIMEOUT_MS,
  );
  let verdict: QuickInputTurnVerdict | null = null;
  let classifyError: unknown;
  try {
    verdict = await params.classify(supervisionInput, {
      model:
        settingText("backend.taskSupervision.model")?.trim() ||
        params.request.model,
      effort:
        settingText("backend.taskSupervision.effort")?.trim() ||
        params.request.effort,
      timeoutMs,
      signal: params.signal,
    });
  } catch (caught) {
    params.checkCancelled();
    classifyError = caught;
  }

  if (!verdict) {
    const detail =
      classifyError instanceof Error && classifyError.message
        ? `（${classifyError.message}）`
        : "";
    return {
      kind: "retain",
      result: {
        provider: "codex",
        threadId: params.threadId,
        outcome: "blocked",
        summary: params.finalMessage.text,
        reason: `完结状态旁路核对未通过${detail}，遵循宁留勿删已保留执行终端。`,
      },
    };
  }

  if (
    verdict.outcome === "completed" &&
    verdict.assessment.disposition === "apply"
  ) {
    return {
      kind: "complete",
      result: {
        provider: "codex",
        threadId: params.threadId,
        outcome: "succeeded",
        summary: params.finalMessage.text,
        reason: "",
      },
    };
  }

  if (
    verdict.outcome === "continue" &&
    verdict.assessment.disposition === "apply"
  ) {
    const canContinue =
      params.request.continuationPolicy?.mode !== "off" &&
      params.continuations < MAX_IN_PLACE_CONTINUATIONS &&
      !params.hasPendingUserInput;
    if (canContinue) {
      const decisionId = randomUUID();
      return {
        kind: "continue",
        decisionId,
        followUpPrompt: buildContinuationPrompt(
          decisionId,
          params.continuations,
          verdict,
        ),
        nextPreviousContinuation: {
          decisionId,
          reportMessageId: params.finalMessage.id,
          remainingWork: verdict.guidance.remainingWork,
          nextAction: verdict.guidance.nextAction,
          authorizationMessageIds: verdict.guidance.authorizationMessageIds,
          noProgressCount: 0,
        },
      };
    }
    return {
      kind: "retain",
      result: {
        provider: "codex",
        threadId: params.threadId,
        outcome: "blocked",
        summary: params.finalMessage.text,
        reason:
          params.continuations >= MAX_IN_PLACE_CONTINUATIONS
            ? `终端内自动续接已达 ${MAX_IN_PLACE_CONTINUATIONS} 次上限，剩余工作：${verdict.guidance.remainingWork || verdict.reason}`
            : `仍有待推进步骤（${verdict.guidance.remainingWork || verdict.reason}），已保留执行终端。`,
      },
    };
  }

  const reason =
    verdict.outcome === "blocked"
      ? `${verdict.guidance.blocker || verdict.reason}${verdict.guidance.requiredUserAction ? `（需处理：${verdict.guidance.requiredUserAction}）` : ""}`
      : `完成度待人工确认（${verdict.reason}），遵循宁留勿删已保留执行终端。`;
  return {
    kind: "retain",
    result: {
      provider: "codex",
      threadId: params.threadId,
      outcome: "blocked",
      summary: params.finalMessage.text,
      reason,
      recovery:
        verdict.outcome === "blocked"
          ? {
              action: "needs-input",
              category: "input",
              evidence: verdict.guidance.blocker || verdict.reason,
              nextStep:
                verdict.guidance.requiredUserAction ||
                verdict.guidance.remainingWork ||
                verdict.reason,
              notBefore: null,
              confirmation: null,
              browser: null,
            }
          : null,
    },
  };
}

async function buildSupervisionInputForTurn(params: {
  prompt: string;
  runId: string;
  workingDirectory: string;
  turns: Array<{ id?: string; messages: ConversationMessage[] }>;
  finalMessage: ConversationMessage;
  rawTurnId: string;
  previousContinuation?: PreviousSupervisionContinuation;
  signal: AbortSignal;
}): Promise<SupervisionInput> {
  const messages = params.turns.flatMap((turn) => turn.messages);
  const realUsers = messages.filter(
    (m) =>
      m.role === "user" &&
      !isSupervisionPrompt(m.text) &&
      !m.text.startsWith("<hook_prompt"),
  );
  const task: ConversationMessage = realUsers[0] ?? {
    id: `quick-input-task:${params.runId}`,
    role: "user",
    text: params.prompt,
    createdAt: new Date().toISOString(),
  };
  const userUpdates = realUsers.slice(1);
  const recentExchanges = messages.filter(
    (m) =>
      m.id !== params.finalMessage.id &&
      m.role === "assistant" &&
      m.phase !== "commentary",
  );
  const plan = await readPlans(
    params.workingDirectory,
    referencedPlans([task, ...userUpdates]),
  ).catch(() => []);
  const input: SupervisionInput = {
    task,
    goal: params.prompt,
    plan,
    userUpdates,
    recentExchanges,
    currentReply: {
      ...params.finalMessage,
      phase: "final",
      rawTurnId: params.rawTurnId,
    },
    ...(params.previousContinuation
      ? { previousContinuation: params.previousContinuation }
      : {}),
  };
  const remaining =
    INPUT_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(input)) - 512;
  if (remaining > 1_024) {
    input.deliverables = await collectDeliverables(
      params.workingDirectory,
      { ...params.finalMessage, role: "assistant" },
      remaining,
      params.signal,
    ).catch(() => ({ items: [], omittedCount: 0 }));
  }
  return input;
}

function buildContinuationPrompt(
  decisionId: string,
  priorCount: number,
  verdict: QuickInputTurnVerdict,
): string {
  const { guidance } = verdict;
  return [
    `[runweave-task-supervision:${decisionId}]`,
    "继续执行用户快捷指令中已授权的剩余工作并完成必要验证。已有授权持续有效；不以阶段汇报代替执行。",
    `本轮判断（按当前快捷指令核对，不新增授权）：${verdict.reason}`,
    ...(guidance.remainingWork ? [`尚未完成：${guidance.remainingWork}`] : []),
    ...(guidance.nextAction ? [`下一步：${guidance.nextAction}`] : []),
    ...(guidance.blocker
      ? [`局部依赖：${guidance.blocker}。先执行上述独立步骤，不自行批准待确认事项。`]
      : []),
    ...(priorCount > 0
      ? [`本轮已自动续接 ${priorCount} 次。请结合前文直接推进剩余步骤，避免重复已完成的操作。`]
      : []),
    "完成后给出清晰结果并停止；若确需用户操作或外部条件解锁，直接用自然语言说明阻塞原因与所需操作。",
  ].join("\n\n");
}
