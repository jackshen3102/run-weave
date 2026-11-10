import type { TerminalAgentKind } from "./terminal/runtime/state";

/** Canonical identities; Trae command aliases are not separate providers. */
export type AgentCapabilityProvider = Exclude<TerminalAgentKind, "traex" | "traecli">;

export const AGENT_CAPABILITY_NAMES = [
  "prepare", "conversation", "resume", "queue", "attachments", "liveSettings",
  "questions", "permissions", "fork", "sideChat", "background",
] as const;
export type AgentCapabilityName = typeof AGENT_CAPABILITY_NAMES[number];

export type AgentCapabilityReason =
  | "integration_unverified"
  | "integration_unavailable"
  | "upstream_unsupported"
  | "platform_unsupported"
  | "cli_missing"
  | "probe_failed"
  | "probe_timeout"
  | "probe_output_limit"
  | "version_unrecognized"
  | "authentication_required"
  | "authentication_unverified"
  | "configuration_invalid"
  | "background_unavailable"
  | "service_closed";

export type AgentCapabilityState =
  | { status: "available"; reason: null }
  | { status: "unsupported" | "unavailable"; reason: AgentCapabilityReason };

export interface AgentProviderCapabilities {
  provider: AgentCapabilityProvider;
  version: string | null;
  /** CLI probe facts only: never evidence that a particular session is ready. */
  availability: AgentCapabilityState;
  /** Integration support; every operation must revalidate its actual target. */
  capabilities: Record<AgentCapabilityName, AgentCapabilityState>;
}

export interface AgentCapabilitiesResponse {
  providers: AgentProviderCapabilities[];
}
