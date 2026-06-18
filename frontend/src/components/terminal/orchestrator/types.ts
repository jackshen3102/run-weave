export type AgentCliCommand = "codex" | "traex";

export interface RoleDraft {
  selected: boolean;
  bindingMode: "new" | "reuse";
  sessionId: string;
  prompt: string;
}
