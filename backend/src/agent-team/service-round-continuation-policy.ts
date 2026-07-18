import type {
  AgentTeamAcceptanceCase,
  AgentTeamRun,
  AgentTeamWorkerRole,
} from "@runweave/shared/agent-team";
import { hasRolePassed } from "./service-acceptance-policy";

export function shouldContinueBeforeNoProgressEscalation(
  run: AgentTeamRun,
  completedWorkerRole: AgentTeamWorkerRole | null | undefined,
  automaticBehaviorCases: AgentTeamAcceptanceCase[],
): boolean {
  if (completedWorkerRole === "code_review") {
    return hasRolePassed(run, "code_review");
  }
  return (
    completedWorkerRole === "behavior_verify" &&
    automaticBehaviorCases.length > 0
  );
}
