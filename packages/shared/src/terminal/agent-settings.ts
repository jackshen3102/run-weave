export type TerminalAgentSettingsProvider = "codex" | "traex";

export interface TerminalAgentSettings {
  terminalSessionId: string;
  panelId: string | null;
  threadId: string;
  provider: TerminalAgentSettingsProvider;
  model: string;
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
  threadId: string;
  expectedRevision: string;
  model: string;
  reasoningEffort: string;
}
