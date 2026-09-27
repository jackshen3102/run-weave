import type {
  EfficiencyObservation,
  SubmitEfficiencyDecision,
} from "@runweave/shared/execution-efficiency";
import { ExecutionEfficiencyError } from "./errors";

export function validateDecision(
  decision: SubmitEfficiencyDecision,
  observations: EfficiencyObservation[],
  projectId: string,
): void {
  if (!observations.length || observations.length !== new Set(decision.observationIds).size) {
    throw invalid("Every decision must reference existing unique observations");
  }
  const dimensions = new Set(observations.map((item) => item.dimension));
  if (
    dimensions.size !== 1 ||
    observations.some((item) => item.projectId !== projectId)
  ) {
    throw invalid("Decision observations must belong to one project and dimension");
  }
  if (decision.verdict === "admit") {
    for (const value of [
      decision.title,
      decision.admissionReason,
      decision.hypothesis,
      decision.uncertainty,
      decision.verification,
    ]) {
      if (!value.trim()) throw invalid("Admitted decisions require complete explanation fields");
    }
  }
}

function invalid(message: string): ExecutionEfficiencyError {
  return new ExecutionEfficiencyError("invalid_input", 400, message);
}
