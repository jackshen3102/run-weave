import type {
  AgentTeamActiveWorkerDispatch,
  AgentTeamRun,
  AgentTeamWorkerOutbox,
} from "@runweave/shared/agent-team";
import type { EvolutionOutcomeObserver } from "../evolution/injection/outcome-observer";
import { agentTeamLogger } from "./service-context";

export async function recordEvolutionCodeObservation(input: {
  observer: EvolutionOutcomeObserver | undefined;
  run: AgentTeamRun;
  dispatch: AgentTeamActiveWorkerDispatch;
  outbox: AgentTeamWorkerOutbox;
}): Promise<void> {
  const { observer, run, dispatch, outbox } = input;
  const dispatchId = dispatch.dispatchId;
  if (!observer || !dispatchId) return;
  try {
    const recorded = await observer.recordAgentFeedbackForDispatch(
      run.runId,
      dispatchId,
      outbox.evolutionFeedback ?? null,
      outbox.finishedAt,
    );
    if (outbox.evolutionFeedback && recorded === 0) {
      agentTeamLogger.warn("agent-team.evolution-feedback.unmatched", {
        message:
          "Evolution feedback had no exposed RuntimeTrace for this dispatch",
        runId: run.runId,
        dispatchId,
      });
    }
    if ((dispatch.repairKeys?.length ?? 0) > 0) {
      await observer.recordForDispatch(
        run.runId,
        dispatchId,
        "repair",
        {
          sourceDispatchId: dispatchId,
          sourceRole: "code",
          repairKeys: dispatch.repairKeys,
          resultStatus: outbox.status,
        },
        outbox.finishedAt,
      );
    }
  } catch (error) {
    agentTeamLogger.warn("agent-team.evolution-code-outcome.fail-open", {
      message: "Evolution code feedback recording failed; Agent Team continues",
      runId: run.runId,
      dispatchId,
      error,
    });
  }
}
