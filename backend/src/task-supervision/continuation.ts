import type { ChangeSupervisionRequest, SupervisionHookResponse, SupervisionTarget, TaskWatch } from "@runweave/shared/task-supervision";
import { currentSupervisionDecisions } from "@runweave/shared/task-supervision";
import type { ConversationContent } from "@runweave/shared/terminal/conversation";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { clearTerminalDraft, terminalInputAdmission } from "../terminal/runtime/input-admission";
import { sameTarget, synchronizeContext } from "./synchronization";
import { taskCandidates } from "./context";
import { SupervisionError } from "./errors";
import { reserveContinuation } from "./verdict";
import { recordDeliveryFailure } from "./delivery";
import { supervisionLogger } from "./diagnostics";

type Offer = Extract<SupervisionHookResponse, { action: "request-continuation" }>;
interface ContinuationOperations {
  get: () => Promise<TaskWatch>;
  watch: () => TaskWatch;
  manager: TerminalSessionManager;
  read: (thread: string) => Promise<ConversationContent>;
  current: (target: SupervisionTarget) => boolean;
  transaction: <T>(operation: () => T | Promise<T>) => Promise<T>;
  cancel: () => void;
  closed: () => boolean;
  deliver?: (target: SupervisionTarget, offer: Offer, valid: () => void) => Promise<void>;
}

/** Both automatic and explicit retries use the same persisted offer and delivery fences. */
export async function sendSupervisionOffer(target: SupervisionTarget, offer: Offer, inputRevision: object,
  operations: ContinuationOperations, options: { signal?: AbortSignal; trace?: Record<string, unknown>; confirmedEmpty?: boolean } = {}) {
  const valid = () => {
    const watch = operations.watch();
    if (operations.closed() || !watch.enabled || watch.revision !== offer.revision || options.signal?.aborted ||
      !operations.current(target) || !operations.manager.getSession(target.terminalSessionId))
      throw new Error("原任务已变化，未发送旧续接。");
  };
  try {
    valid();
    const session = operations.manager.getSession(target.terminalSessionId)!;
    if (terminalInputAdmission(session).revision !== inputRevision) throw new Error("用户输入已变化，未发送旧续接。");
    if (!operations.deliver) throw new Error("终端输入服务不可用。");
    if (options.confirmedEmpty) clearTerminalDraft(session, operations.manager.getPanel(target.panelId)?.tmuxPaneId ?? null, "user-confirmed-empty");
    await operations.deliver(target, offer, valid);
    supervisionLogger.info("task-supervision.delivery.sent", { ...options.trace, ...target, decisionId: offer.decisionId });
  } catch (error) {
    supervisionLogger.warn("task-supervision.delivery.failed", { ...options.trace, ...target, decisionId: offer.decisionId, error });
    await operations.transaction(() => recordDeliveryFailure(operations.watch(), offer.decisionId, error, operations.current(target)));
  }
}

export async function retryContinuation(request: ChangeSupervisionRequest, operations: ContinuationOperations) {
  const snapshot = await operations.get();
  const target = snapshot.target;
  // Require live conversation evidence. A UI confirmation alone cannot revive an old task.
  const source = await operations.read(target.threadId);
  if (source.availability !== "available") throw new SupervisionError("原会话暂不可读，未重试续接。", 422);
  await operations.transaction(() => {
    if (operations.current(target) && sameTarget(operations.watch().target, target))
      synchronizeContext(operations.watch(), taskCandidates(source), operations.cancel);
  });
  const session = operations.manager.getSession(target.terminalSessionId);
  const panel = operations.manager.getPanel(target.panelId);
  if (!session || !panel || panel.terminalState?.state !== "agent_idle")
    throw new SupervisionError("原 Agent 当前不是空闲状态，未重试续接。");
  const inputRevision = terminalInputAdmission(session).revision;
  const offer = await operations.transaction(() => {
    const watch = operations.watch();
    const decision = currentSupervisionDecisions(watch).at(-1);
    const latestReply = source.turns.flatMap((turn) => turn.messages)
      .filter((message) => message.role === "assistant" && message.phase !== "commentary").at(-1);
    if (!operations.current(target) || !sameTarget(watch.target, target) || !watch.enabled || watch.waitingFor || watch.revision !== request.expectedRevision ||
      !request.expectedInputVersion || terminalInputAdmission(session).inputVersion !== request.expectedInputVersion ||
      !decision || decision.decisionId !== request.decisionId || decision.outcome !== "continue" ||
      decision.delivery !== "not_requested" || decision.deliveryBlock !== "draft_unconfirmed" || watch.status !== "error" ||
      latestReply?.id !== decision.input.currentReply.id || panel.terminalState?.state !== "agent_idle")
      throw new SupervisionError("任务或输入已变化，请重新读取并核对后重试。");
    if (terminalInputAdmission(session).pendingUserInput.has(null) && panel.tmuxPaneId != null)
      throw new SupervisionError("存在无法定位面板的输入，请在原终端提交后继续。", 422);
    watch.revision++;
    watch.updatedAt = new Date().toISOString();
    return reserveContinuation(watch, decision);
  });
  if (offer.action === "request-continuation")
    await sendSupervisionOffer(target, offer, inputRevision, operations, { confirmedEmpty: true, trace: { source: "user-retry" } });
  return operations.get();
}
