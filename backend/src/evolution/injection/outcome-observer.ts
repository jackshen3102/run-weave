import { randomUUID } from "node:crypto";
import type { AgentTeamEvolutionFeedback } from "@runweave/shared/agent-team";
import type { RuntimeTraceEvent } from "@runweave/shared/evolution";
import type { EvolutionActivationStore } from "../activation-store";

export type ObjectiveOutcomeKind = Extract<
  RuntimeTraceEvent["kind"],
  | "agent_feedback"
  | "review_gate"
  | "behavior_gate"
  | "repair"
  | "user_correction"
  | "completed"
  | "cancelled"
>;

export class EvolutionOutcomeObserver {
  constructor(private readonly store: EvolutionActivationStore) {}

  record(
    traceId: string,
    kind: ObjectiveOutcomeKind,
    detail: Record<string, unknown>,
    at: string = new Date().toISOString(),
  ): Promise<void> {
    return this.store.appendRuntimeTraceEvent(traceId, {
      eventId: randomUUID(),
      traceId,
      kind,
      at,
      detail,
    });
  }

  async recordForDispatch(
    runId: string,
    dispatchId: string,
    kind: ObjectiveOutcomeKind,
    detail: Record<string, unknown>,
    at: string = new Date().toISOString(),
  ): Promise<number> {
    const traces = await this.store.listRuntimeTraces(runId);
    const matched = traces.filter((trace) => trace.dispatchId === dispatchId);
    await Promise.all(
      matched.map((trace) => this.record(trace.traceId, kind, detail, at)),
    );
    return matched.length;
  }

  async recordAgentFeedbackForDispatch(
    runId: string,
    dispatchId: string,
    feedback: AgentTeamEvolutionFeedback | null,
    at: string = new Date().toISOString(),
  ): Promise<number> {
    const traces = (await this.store.listRuntimeTraces(runId)).filter(
      (trace) =>
        trace.dispatchId === dispatchId && trace.exposedRevisionIds.length > 0,
    );
    await Promise.all(
      traces.map((trace) => {
        const feedbackMatchesTrace =
          feedback !== null &&
          feedback.assetRevisionIds.length > 0 &&
          feedback.assetRevisionIds.every((revisionId) =>
            trace.exposedRevisionIds.includes(revisionId),
          );
        return this.record(
          trace.traceId,
          "agent_feedback",
          feedbackMatchesTrace
            ? {
                sourceDispatchId: dispatchId,
                disposition: feedback.disposition,
                assetRevisionIds: feedback.assetRevisionIds,
                summary: feedback.summary,
                advisoryOnly: true,
              }
            : {
                sourceDispatchId: dispatchId,
                disposition: "missing",
                assetRevisionIds: trace.exposedRevisionIds,
                summary: feedback
                  ? "Evolution feedback referenced a revision that was not exposed for this dispatch."
                  : "Evolution feedback was omitted for an exposed context.",
                advisoryOnly: true,
                missing: true,
              },
          at,
        );
      }),
    );
    return traces.length;
  }
}
