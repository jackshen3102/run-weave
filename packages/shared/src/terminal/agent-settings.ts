export type TerminalAgentSettingsProvider = "codex" | "traex" | "agy";

export interface TerminalAgentSettings {
  terminalSessionId: string;
  panelId: string | null;
  /** A live CLI can offer settings before it has established a conversation. */
  threadId: string | null;
  provider: TerminalAgentSettingsProvider;
  model: string | null;
  /** Preselection from the CLI's defaults when the active selection is unavailable. */
  modelSource?: "default";
  reasoningEffort: string | null;
  revision: string;
}

export interface TerminalAgentModelOption {
  id: string;
  label: string;
  description: string;
  defaultReasoningEffort: string | null;
  reasoningEfforts: string[];
}

export interface TerminalAgentSettingsResponse {
  settings: TerminalAgentSettings;
  models: TerminalAgentModelOption[];
}

export interface UpdateTerminalAgentSettingsRequest {
  panelId: string | null;
  threadId: string | null;
  expectedRevision: string;
  model: string;
  reasoningEffort: string;
}
