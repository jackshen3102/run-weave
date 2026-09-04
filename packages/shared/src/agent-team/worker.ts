export type AgentTeamWorkerRole = "code" | "code_review" | "behavior_verify";

export interface AgentTeamWorker {
  id: string;
  role: AgentTeamWorkerRole;
  intent: string;
  /** tmux panel id bound after split; null before executing. */
  panelId?: string | null;
  tmuxPaneId?: string | null;
  /** Whether the orchestration layer is currently injecting rounds into it. */
  frozen?: boolean;
}
