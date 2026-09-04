import type { AgentTeamWorkerRole } from "./worker";
import type { AgentTeamTerminal } from "./run-contract";

export type AgentTeamRole = "main" | AgentTeamWorkerRole;
export type AgentTeamModelProvider = "codex" | "traex";

export interface AgentTeamCatalogModel {
  id: string;
  label: string;
  description: string;
  contextWindow: number | null;
  defaultReasoningEffort: string | null;
  reasoningEfforts: string[];
  supportsFast: boolean;
  supportsMax: boolean;
}

export interface AgentTeamProviderCatalog {
  provider: AgentTeamModelProvider;
  command: AgentTeamModelProvider;
  availability: "available" | "unavailable";
  source: "fresh" | "cache" | "none";
  version: string | null;
  capturedAt: string | null;
  models: AgentTeamCatalogModel[];
  errorCode: "cli_missing" | "catalog_unavailable" | null;
}

export type AgentTeamRoleModelConfig =
  | {
      provider: "codex";
      model: string;
      reasoningEffort: string | null;
      fast: boolean;
    }
  | {
      provider: "traex";
      model: string;
      reasoningEffort: string | null;
      max: boolean;
    };

export type AgentTeamRoleModelConfigMap = Record<
  AgentTeamRole,
  AgentTeamRoleModelConfig
>;

export interface AgentTeamGlobalModelConfig {
  schemaVersion: 1;
  roles: AgentTeamRoleModelConfigMap;
  updatedAt: string;
}

export interface AgentTeamModelSettingsResponse {
  config: AgentTeamGlobalModelConfig | null;
  catalogs: Record<AgentTeamModelProvider, AgentTeamProviderCatalog>;
}

export interface SaveAgentTeamModelConfigRequest {
  roles: AgentTeamRoleModelConfigMap;
}

export interface AgentTeamRoleRuntime {
  selection: AgentTeamRoleModelConfig;
  terminal: AgentTeamTerminal;
  providerVersion: string | null;
  catalogCapturedAt: string | null;
}

export interface AgentTeamRoleRuntimeSnapshot {
  schemaVersion: 1;
  source: "global_config" | "retry_snapshot" | "legacy_terminal";
  capturedAt: string;
  roles: Record<AgentTeamRole, AgentTeamRoleRuntime>;
}

export type AgentTeamModelErrorDetails =
  | { code: "config_required" }
  | {
      code: "provider_unavailable";
      role: AgentTeamRole;
      provider: AgentTeamModelProvider;
    }
  | {
      code: "model_unavailable";
      role: AgentTeamRole;
      provider: AgentTeamModelProvider;
      model: string;
    }
  | {
      code: "parameter_unsupported";
      role: AgentTeamRole;
      provider: AgentTeamModelProvider;
      model: string;
      parameter: string;
    }
  | {
      code: "main_panel_not_shell_idle";
      state: string;
    };
