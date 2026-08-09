import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamOutboxHistoryRecord,
  AgentTeamRun,
  AgentTeamWorker,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import type { TerminalEventEnvelope } from "@runweave/shared/terminal/events";
import {
  buildAcceptanceSkipCorrectionPrompt,
  buildBehaviorFailureCorrectionPrompt,
  buildReviewFindingCorrectionPrompt,
} from "./prompt-builders";
import type { AgentTeamResolvedOutbox } from "./outbox-resolver";
import {
  behaviorFailureContractErrors,
  resolvePendingFindingDecision,
  reviewFindingContractErrors,
  type AgentTeamRepairTarget,
} from "./repair-loop";
import { captureRepairSourceFingerprint } from "./repair-source-fingerprint";
import { AgentTeamCompletionRecoveryService } from "./service-completion-recovery";
import { recordEvolutionCodeObservation } from "./service-evolution-outcome";
import type { AgentTeamCompletionSignalSource } from "./service-types";
import { behaviorSkipContractErrors } from "./service-acceptance-policy";
import {
  completionOutboxIdentityMismatch,
  completionReviewTargetMismatch,
  completionSignalWorkerMismatch,
  findWorkerByRole,
  resolveActiveWorkerDispatch,
  workerOutboxFreshnessMismatch,
} from "./service-workflow-policy";
import {
  logConsumedCompletion,
  logStaleCompletion,
} from "./service-completion-logging";

type CompletionEvent = Extract<TerminalEventEnvelope, { kind: "completion" }>;

interface CompletionRound {
  acceptanceResults: NonNullable<AgentTeamWorkerOutbox["acceptanceResults"]>;
  forceBounceCaseIds: string[];
  repairTargets: AgentTeamRepairTarget[];
}

interface CompletionContext {
  activeWorker: AgentTeamWorker;
  dispatch: AgentTeamActiveWorkerDispatch;
  outbox: AgentTeamWorkerOutbox;
  outboxMtimeMs: number | null;
  resolvedOutbox: AgentTeamResolvedOutbox;
}

type CompletionStageResult<T> =
  | { status: "stop"; handled: boolean }
  | { status: "ready"; value: T };

interface ArchivedCompletion {
  transitionRun: AgentTeamRun;
  archivedOutbox: {
    record: AgentTeamOutboxHistoryRecord;
    created: boolean;
  };
}

export abstract class AgentTeamCompletionPreparationService extends AgentTeamCompletionRecoveryService {
  protected abstract resolveOutboxRound(
    run: AgentTeamRun,
    outbox: AgentTeamWorkerOutbox,
  ): CompletionRound;

  protected abstract withConsumedWorkerDispatch(
    run: AgentTeamRun,
    history: AgentTeamOutboxHistoryRecord,
  ): AgentTeamRun;

  protected abstract validateCodeHandoff(
    latest: AgentTeamRun,
    transitionRun: AgentTeamRun,
    activeWorker: AgentTeamWorker,
    outbox: AgentTeamWorkerOutbox,
    outboxMtimeMs: number | null,
  ): Promise<"ready" | "stopped">;

  protected async resolveCompletionContext(
    latest: AgentTeamRun,
    event: CompletionEvent,
    source: AgentTeamCompletionSignalSource,
  ): Promise<CompletionStageResult<CompletionContext>> {
    const resolvedOutbox =
      await this.outboxResolver.resolveOutboxWithMetadata(event);
    if (!resolvedOutbox) {
      return { status: "stop", handled: false };
    }
    const { outbox, mtimeMs: outboxMtimeMs } = resolvedOutbox;
    const consumedReceipt = outbox.dispatchId
      ? latest.consumedWorkerDispatches?.find(
          (receipt) => receipt.dispatchId === outbox.dispatchId,
        )
      : null;
    if (consumedReceipt) {
      logConsumedCompletion(source, latest, consumedReceipt);
      return { status: "stop", handled: true };
    }
    if (!latest.activeWorkerRole) {
      return { status: "stop", handled: false };
    }
    const activeWorker = findWorkerByRole(
      latest.workers,
      latest.activeWorkerRole,
    );
    if (!activeWorker) {
      return { status: "stop", handled: false };
    }
    const signalMismatch = completionSignalWorkerMismatch(event, activeWorker);
    if (signalMismatch) {
      logStaleCompletion(source, latest, activeWorker, signalMismatch);
      return { status: "stop", handled: false };
    }
    const dispatch = resolveActiveWorkerDispatch(latest, activeWorker);
    if (!dispatch) {
      await this.recoverMissingActiveWorkerDispatch(latest, activeWorker);
      return { status: "stop", handled: true };
    }
    const identityMismatch = completionOutboxIdentityMismatch(
      latest,
      activeWorker,
      dispatch,
      outbox,
      source !== "terminal_event",
    );
    if (identityMismatch) {
      if (
        identityMismatch === "active_dispatch_id_missing" ||
        identityMismatch === "outbox_dispatch_id_missing"
      ) {
        await this.pauseForRepairProtocolError(
          latest,
          `dispatch-id-v1 协议错误：${identityMismatch}`,
        );
        return { status: "stop", handled: true };
      }
      logStaleCompletion(source, latest, activeWorker, identityMismatch);
      return { status: "stop", handled: false };
    }
    const freshnessMismatch = workerOutboxFreshnessMismatch(
      dispatch,
      outboxMtimeMs,
    );
    if (freshnessMismatch) {
      logStaleCompletion(source, latest, activeWorker, freshnessMismatch);
      return { status: "stop", handled: false };
    }
    return {
      status: "ready",
      value: {
        activeWorker,
        dispatch,
        outbox,
        outboxMtimeMs,
        resolvedOutbox,
      },
    };
  }

  protected async archiveAndVerifyCompletion(
    latest: AgentTeamRun,
    event: CompletionEvent,
    context: CompletionContext,
  ): Promise<CompletionStageResult<ArchivedCompletion>> {
    const { dispatch, outbox, resolvedOutbox } = context;
    let archivedOutbox;
    try {
      archivedOutbox = await this.outboxHistoryStore.archive({
        run: latest,
        dispatch,
        resolvedOutbox,
        cwd: event.payload.cwd,
      });
    } catch (error) {
      await this.pauseForRepairProtocolError(
        latest,
        `worker outbox 历史归档失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "stop", handled: true };
    }
    const transitionRun = this.withConsumedWorkerDispatch(
      latest,
      archivedOutbox.record,
    );
    if (dispatch.protocolCorrectionAttempt) {
      const verified = await this.verifyProtocolCorrectionSource(
        latest,
        event,
        transitionRun,
        dispatch,
      );
      if (!verified) {
        return { status: "stop", handled: true };
      }
    }
    const reviewTargetMismatch = completionReviewTargetMismatch(latest, outbox);
    if (reviewTargetMismatch) {
      await this.pauseForCheckpointError(transitionRun, reviewTargetMismatch);
      return { status: "stop", handled: true };
    }
    return {
      status: "ready",
      value: { transitionRun, archivedOutbox },
    };
  }

  protected async validateCompletionContracts(
    latest: AgentTeamRun,
    transitionRun: AgentTeamRun,
    context: CompletionContext,
  ): Promise<CompletionStageResult<CompletionRound>> {
    const { activeWorker, dispatch, outbox, outboxMtimeMs } = context;
    const initialRound = this.resolveOutboxRound(latest, outbox);
    const skipContractErrors =
      outbox.role === "behavior_verify"
        ? behaviorSkipContractErrors(latest, initialRound.acceptanceResults)
        : [];
    if (skipContractErrors.length > 0) {
      await this.handleProtocolCorrection(
        transitionRun,
        activeWorker,
        outboxMtimeMs,
        skipContractErrors,
        (run) =>
          buildAcceptanceSkipCorrectionPrompt({
            run,
            errors: skipContractErrors,
          }),
        "behavior_verify skip",
      );
      return { status: "stop", handled: true };
    }
    const behaviorContractErrors = behaviorFailureContractErrors(
      outbox,
      initialRound.acceptanceResults,
    );
    if (behaviorContractErrors.length > 0) {
      await this.handleProtocolCorrection(
        transitionRun,
        activeWorker,
        outboxMtimeMs,
        behaviorContractErrors,
        (run) =>
          buildBehaviorFailureCorrectionPrompt({
            run,
            errors: behaviorContractErrors,
          }),
        "behavior_verify reproduction",
      );
      return { status: "stop", handled: true };
    }
    const reviewContractErrors = reviewFindingContractErrors(
      latest,
      outbox,
      initialRound.acceptanceResults,
    );
    if (reviewContractErrors.length > 0) {
      await this.handleProtocolCorrection(
        transitionRun,
        activeWorker,
        outboxMtimeMs,
        reviewContractErrors,
        (run) =>
          buildReviewFindingCorrectionPrompt({
            run,
            errors: reviewContractErrors,
          }),
        "code_review finding",
      );
      return { status: "stop", handled: true };
    }
    const pendingFindingDecision = resolvePendingFindingDecision(
      latest,
      outbox,
    );
    if (pendingFindingDecision) {
      await this.pauseForFindingDecision(transitionRun, pendingFindingDecision);
      return { status: "stop", handled: true };
    }
    if (outbox.role === "code") {
      const handoffResult = await this.validateCodeHandoff(
        latest,
        transitionRun,
        activeWorker,
        outbox,
        outboxMtimeMs,
      );
      if (handoffResult !== "ready") {
        return { status: "stop", handled: true };
      }
      await recordEvolutionCodeObservation({
        observer: this.evolutionOutcomeObserver,
        run: latest,
        dispatch,
        outbox,
      });
    }
    return { status: "ready", value: initialRound };
  }

  private async verifyProtocolCorrectionSource(
    latest: AgentTeamRun,
    event: CompletionEvent,
    transitionRun: AgentTeamRun,
    dispatch: AgentTeamActiveWorkerDispatch,
  ): Promise<boolean> {
    const expected = dispatch.protocolCorrectionSourceFingerprint;
    if (!expected) {
      await this.pauseForRepairProtocolError(
        transitionRun,
        "协议补交缺少源码指纹，无法证明补交期间未修改源码",
      );
      return false;
    }
    try {
      const actual = await captureRepairSourceFingerprint(
        this.resolveRequiredProjectRoot(
          latest.projectId,
          event.payload.cwd ?? latest.terminal.cwd ?? "",
        ),
      );
      if (
        actual.repoRoot !== expected.repoRoot ||
        actual.sha256 !== expected.sha256
      ) {
        await this.pauseForRepairProtocolError(
          transitionRun,
          "协议补交期间源码、Git HEAD 或 index 已变化",
        );
        return false;
      }
      return true;
    } catch (error) {
      await this.pauseForRepairProtocolError(
        transitionRun,
        `协议补交源码指纹复核失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
}
