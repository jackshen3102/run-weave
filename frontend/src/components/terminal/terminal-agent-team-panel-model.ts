import type { AgentTeamRun, AgentTeamWorkerRole } from "@runweave/shared";

export const AGENT_TEAM_POLL_INTERVAL_MS = 4000;

export const PHASE_LABEL: Record<AgentTeamRun["phase"], string> = {
  intake: "任务接收",
  proposal: "拆分提案",
  executing: "执行观测",
};

export const ROLE_LABEL: Record<AgentTeamWorkerRole, string> = {
  code: "code",
  code_review: "code_review",
  behavior_verify: "behavior_verify",
};

export const ROLE_CYCLE: AgentTeamWorkerRole[] = [
  "code",
  "code_review",
  "behavior_verify",
];

export interface WorkerDraft {
  role: AgentTeamWorkerRole;
  intent: string;
}
