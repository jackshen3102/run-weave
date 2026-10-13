export type AgentModelProvider = "codex" | "traex";

export interface AgentCatalogModel {
  id: string;
  label: string;
  description: string;
  contextWindow: number | null;
  defaultReasoningEffort: string | null;
  reasoningEfforts: string[];
  supportsFast: boolean;
  supportsMax: boolean;
}

export interface AgentProviderCatalog {
  provider: AgentModelProvider;
  command: AgentModelProvider;
  availability: "available" | "unavailable";
  source: "fresh" | "cache" | "none";
  version: string | null;
  capturedAt: string | null;
  models: AgentCatalogModel[];
  errorCode: "cli_missing" | "catalog_unavailable" | null;
}

export interface AgentModelCatalogsResponse {
  catalogs: Record<AgentModelProvider, AgentProviderCatalog>;
}
