import { randomUUID } from "node:crypto";
import { configuration } from "@runweave/config-node";
import type {
  SupervisionHookResponse,
  SupervisionTarget,
  TaskWatch,
} from "@runweave/shared/task-supervision";
import type { SupervisionConversationResponse } from "@runweave/shared/terminal/conversation";
import type { TerminalSessionManager } from "../terminal/manager/manager";
import { AppServerConversationError } from "../app-server/client";
import {
  hasPendingTerminalInput,
  terminalInputAdmission,
} from "../terminal/runtime/input-admission";
import { previousContinuation } from "./assessment";
import { prepareGoalEvidence } from "./goals";
import { sameTarget, synchronizeContext } from "./synchronization";
import { readFinalReply, alreadyProcessedReply, isRuntimeErrorReply } from "./reply";
import {
  buildSupervisionInput,
  digest,
  refreshReferencedPlans,
  taskCandidates,
  INPUT_BUDGET_BYTES,
} from "./context";
import { collectDeliverables } from "./deliverables";
import { reconcileDelivery } from "./delivery";
import { applyVerdict } from "./verdict";
import { sendSupervisionOffer } from "./continuation";
import { supervisionLogger, replyFields, watchFields } from "./diagnostics";
import type { TaskSupervisionClassifier } from "./classifier";
import type { ArchiveChange, TaskSupervisionStore } from "./store";
import type { ReplyEvent } from "./events";

interface ReplyOperations {
  readContext: (
    id: string,
    thread: string,
  ) => Promise<SupervisionConversationResponse>;
  transaction: <T>(operation: () => T | Promise<T>) => Promise<T>;
  find: (id: string) => TaskWatch;
  current: (target: SupervisionTarget) => boolean;
  resolve: (terminal: string, panel: string) => { root: string };
  manager: TerminalSessionManager;
  classifier: TaskSupervisionClassifier;
  store: Pick<TaskSupervisionStore, "processed" | "goalDetail" | "summary">;
  modelOptions: () => { model?: string; effort?: string; timeoutMs: number };
  archive: (change: ArchiveChange) => void;
  continuationOperations: (
    id: string,
  ) => Parameters<typeof sendSupervisionOffer>[3];
}
const ALLOW: SupervisionHookResponse = { action: "allow-stop" };

/** One final reply: reconcile its goal, classify, then reserve and deliver under the same fences. */
export async function processSupervisionReply(
  operations: ReplyOperations,
  id: string,
  target: SupervisionTarget,
  event: ReplyEvent,
  controller: AbortController,
  inputRevision: object,
): Promise<SupervisionHookResponse> {
  let revision: number | undefined;
  const startedAt = Date.now();
  let stage = "read_final_reply";
  const trace = {
    ...replyFields(event),
    ...target,
    watchId: id,
    attemptId: randomUUID(),
  };
  const skip = (reason: string) =>
    supervisionLogger.info("task-supervision.reply.skipped", {
      ...trace,
      reason,
    });
  supervisionLogger.info("task-supervision.reply.started", trace);
  try {
    const { source, messages, native } = await readFinalReply(
      () => operations.readContext(id, target.threadId),
      event,
      controller.signal,
    );
    const finalKey = `${target.threadId}:${native.id}`;
    stage = "prepare_context";
    let snapshot = await operations.transaction(async () => {
      if (controller.signal.aborted) return null;
      const w = operations.find(id);
      if (
        !w.enabled ||
        controller.signal.aborted ||
        !operations.current(target)
      ) {
        skip("target_changed_or_canceled");
        return null;
      }
      if (!sameTarget(w.target, target)) {
        skip("target_changed");
        return null;
      }
      synchronizeContext(w, taskCandidates(source));
      w.sourceVersion = source.sourceVersion;
      const latestUser = taskCandidates(source).at(-1);
      const latestInput = messages.filter((message) => message.role === "user").at(-1);
      if (
        w.pauseReason === "interrupted" ||
        (native.role === "runtime_error" && w.waitingFor) ||
        (native.role === "runtime_error" && latestInput?.rawTurnId &&
          latestInput.rawTurnId !== native.rawTurnId) ||
        (native.role !== "runtime_error" && latestUser &&
          messages.indexOf(latestUser) > messages.findIndex((message) => message.id === native.id))
      ) {
        delete w.pendingReply;
        skip("interrupted_or_new_user_input");
        return null;
      }
      if (
        w.goalDefinition &&
        w.goalState === "ready" &&
        (alreadyProcessedReply(w, target.threadId, native) ||
          operations.store.processed(
            id,
            target.threadId,
            native.id,
            native.rawTurnId ?? native.id,
            w.goalDefinition.version,
            w.contextRevision,
          ))
      ) {
        delete w.pendingReply;
        skip("duplicate_reply");
        return null;
      }
      if (w.taskStartMessageId.startsWith("pending:"))
        throw new Error("监控已开启，但当前会话还没有可读的用户任务。");
      reconcileDelivery(w, messages);
      if (w.pauseReason === "delivery_unknown")
        throw new Error("上次续接尚未确认接收，请检查原终端。");
      w.revision++;
      w.status = "classifying";
      delete w.error;
      delete w.waitingFor;
      w.updatedAt = new Date().toISOString();
      return w;
    });
    if (!snapshot) return ALLOW;
    revision = snapshot.revision;
    const configurationGeneration = configuration().domainGeneration("backend.taskSupervision");
    const modelOptions = operations.modelOptions();
    if (snapshot.goalDefinition)
      snapshot.plans =
        operations.store.goalDetail(id, snapshot.goalDefinition.revisionId)
          ?.plans ?? snapshot.plans;
    if (
      snapshot.goalState === "needs_review" &&
      snapshot.goalCheckedMessageId === snapshot.lastUserMessageId
    ) {
      await operations.transaction(() => {
        const w = operations.find(id);
        if (w.revision === revision) {
          w.status = "watching";
          delete w.pendingReply;
        }
      });
      return ALLOW;
    }
    if (
      !snapshot.goalDefinition ||
      snapshot.goalCheckedMessageId !== snapshot.lastUserMessageId ||
      snapshot.goalState !== "ready"
    ) {
      stage = "resolve_goal";
      const evidence = await prepareGoalEvidence(
        snapshot,
        source,
        operations.resolve(target.terminalSessionId, target.panelId).root,
      );
      const resolved = await operations.classifier.generateGoal(
        snapshot,
        evidence,
        { ...modelOptions, signal: controller.signal },
      );
      snapshot = await operations.transaction(() => {
        if (controller.signal.aborted) return null;
        const w = operations.find(id);
        if (
          controller.signal.aborted ||
          configuration().domainGeneration("backend.taskSupervision") !== configurationGeneration ||
          !operations.current(target) ||
          w.revision !== revision ||
          terminalInputAdmission(
            operations.manager.getSession(target.terminalSessionId)!,
          ).revision !== inputRevision
        )
          return null;
        w.goalState = resolved.needsClarification ? "needs_review" : "ready";
        w.goalReason = resolved.reason;
        w.goalCheckedMessageId = resolved.checkedMessageId;
        if (resolved.needsClarification) {
          w.status = "watching";
          delete w.pendingReply;
        } else if (resolved.changed) {
          w.goalDefinition = resolved.goal;
          w.goal = resolved.goal.objective;
          delete w.goalOverride;
          w.contextRevision++;
          operations.archive({
            watchId: id,
            goal: {
              goal: resolved.goal,
              messages: resolved.messages,
              plans: resolved.plans,
              reason: resolved.reason,
            },
          });
        }
        w.revision++;
        w.updatedAt = new Date().toISOString();
        return w;
      });
      if (!snapshot || resolved.needsClarification) return ALLOW;
      revision = snapshot.revision;
    }
    stage = "build_input";
    if (snapshot.goalDefinition)
      snapshot.plans =
        operations.store.goalDetail(id, snapshot.goalDefinition.revisionId)
          ?.plans ?? snapshot.plans;
    await refreshReferencedPlans(
      operations.resolve(target.terminalSessionId, target.panelId).root,
      snapshot,
      messages,
    );
    const reply = {
      ...native,
      rawTurnId: native.rawTurnId ?? native.id,
      ...(native.role !== "runtime_error" ? { phase: "final" as const } : {}),
    };
    const previous = previousContinuation(snapshot,
      snapshot.lastObservedContinuationId ? operations.store.summary(id, snapshot.lastObservedContinuationId) : undefined);
    const input = buildSupervisionInput(snapshot, source, reply, previous);
    input.deliverables = native.role === "runtime_error" ? { items: [], omittedCount: 0 } : await collectDeliverables(
      operations.resolve(target.terminalSessionId, target.panelId).root,
      { ...reply, role: "assistant" },
      INPUT_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(input)) - 100,
      controller.signal,
    );
    if (Buffer.byteLength(JSON.stringify(input)) > INPUT_BUDGET_BYTES)
      throw new Error("交付物读取状态超出上下文预算；本次未自动继续。");
    stage = "classify";
    supervisionLogger.info("task-supervision.classification.started", {
      ...trace,
      ...watchFields(snapshot),
      replyMessageId: reply.id,
      inputBytes: Buffer.byteLength(JSON.stringify(input)),
      configuredModel: modelOptions.model ?? null,
      configuredEffort: modelOptions.effort ?? null,
      timeoutMs: modelOptions.timeoutMs,
    });
    const result = await operations.classifier.run(input, {
      ...modelOptions,
      signal: controller.signal,
    });
    supervisionLogger.info("task-supervision.classification.finished", {
      ...trace,
      replyMessageId: reply.id,
      outcome: result.outcome,
      scores: result.scores,
      model: result.model,
      durationMs: result.durationMs,
    });
    stage = "commit_decision";
    const offer = await operations.transaction(() => {
      if (controller.signal.aborted) return ALLOW;
      const w = operations.find(id);
      if (
        !w.enabled ||
        configuration().domainGeneration("backend.taskSupervision") !== configurationGeneration ||
        w.revision !== revision ||
        controller.signal.aborted ||
        !operations.current(target) ||
        terminalInputAdmission(
          operations.manager.getSession(target.terminalSessionId)!,
        ).revision !== inputRevision
      ) {
        if (w.pendingReply?.eventId === event.eventId) delete w.pendingReply;
        if (w.revision === revision && w.status === "classifying")
          w.status = "watching";
        skip("classification_superseded");
        return ALLOW;
      }
      w.plans = snapshot.plans;
      delete w.pendingReply;
      w.evidenceMessageIds = [
        ...new Set([
          input.task.id,
          ...result.sourceMessageIds,
          ...(result.assessment?.criteria.flatMap((row) => row.sourceMessageIds) ?? []),
          ...(result.assessment?.progress?.sourceMessageIds ?? []),
          ...result.guidance.authorizationMessageIds,
          ...(previous ? [previous.reportMessageId] : []),
        ]),
      ].filter((messageId) => !messageId.startsWith("goal-manual:") && !isRuntimeErrorReply(messageId));
      if (native.role !== "runtime_error" && result.outcome === "completed" && result.assessment?.disposition !== "hold")
        w.completedReplyIds = [
          ...new Set([...(w.completedReplyIds ?? []), reply.id]),
        ];
      if (
        new Set([
          ...(w.evidenceMessageIds ?? []),
          ...(w.completedReplyIds ?? []),
        ]).size > 63
      )
        throw new Error(
          "当前会话必要证据引用超过预算；本次未自动继续，监听保持开启。",
        );
      // A failed classification is not a processed reply. Commit the cursor with the decision.
      w.lastFinalMessageId = finalKey;
      const decision = {
        ...result,
        decisionId: randomUUID(),
        threadId: target.threadId,
        rawTurnId: reply.rawTurnId,
        replyDigest: digest(reply.text),
        contextRevision: w.contextRevision,
        goalVersion: w.goalDefinition?.version,
        sourceVersion: w.sourceVersion,
        createdAt: new Date().toISOString(),
        input,
        delivery: "not_requested" as "not_requested" | "offered",
        deliveryDeadline: Date.now() + 30_000,
      };
      const session = operations.manager.getSession(target.terminalSessionId)!;
      const paneId =
        operations.manager.getPanel(target.panelId)?.tmuxPaneId ?? null;
      operations.archive({ watchId: id, decision });
      return applyVerdict(
        w,
        decision,
        !hasPendingTerminalInput(session, paneId),
      );
    });
    if (offer.action !== "request-continuation") return ALLOW;
    stage = "deliver";
    await sendSupervisionOffer(
      target,
      offer,
      inputRevision,
      operations.continuationOperations(id),
      {
        signal: controller.signal,
        trace,
        configurationIsCurrent: () => configuration().domainGeneration("backend.taskSupervision") === configurationGeneration,
      },
    );
    return ALLOW;
  } catch (error) {
    if (controller.signal.aborted)
      supervisionLogger.info("task-supervision.reply.canceled", {
        ...trace,
        stage,
        durationMs: Date.now() - startedAt,
      });
    else
      supervisionLogger.warn("task-supervision.reply.failed", {
        ...trace,
        stage,
        durationMs: Date.now() - startedAt,
        error,
      });
    await operations
      .transaction(() => {
        if (controller.signal.aborted) return;
        const w = operations.find(id);
        if (
          !w.enabled ||
          controller.signal.aborted ||
          !operations.current(target) ||
          (revision !== undefined && w.revision !== revision)
        )
          return;
        if (
          !(
            error instanceof AppServerConversationError &&
            error.code === "CONTEXT_INDEXING"
          )
        )
          delete w.pendingReply;
        w.status = "error";
        if (stage === "resolve_goal") {
          w.goalState = "needs_review";
          w.goalReason =
            error instanceof Error ? error.message : "目标整理失败。";
        }
        w.revision++;
        w.error = (
          error instanceof Error ? error.message : "回复处理失败"
        ).slice(0, 500);
        w.updatedAt = new Date().toISOString();
      })
      .catch((saveError) =>
        supervisionLogger.error("task-supervision.error_state.failed", {
          ...trace,
          error: saveError,
        }),
      );
    return ALLOW;
  } finally {
    supervisionLogger.info("task-supervision.reply.finished", {
      ...trace,
      stage,
      durationMs: Date.now() - startedAt,
    });
  }
}
