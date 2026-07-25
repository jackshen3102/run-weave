import type { EvolutionProviderRequest } from "./types";

export function buildEvolutionMcpConfigArgs(
  request: EvolutionProviderRequest,
): string[] {
  if (!request.mcp) return [];
  const endpoint = new URL(request.mcp.url);
  if (
    endpoint.protocol !== "http:" ||
    !isLoopbackHostname(endpoint.hostname) ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error("provider_mcp_endpoint_invalid");
  }
  return [
    "--config",
    `mcp_servers.runweave-evolution.url=${JSON.stringify(endpoint.toString())}`,
    "--config",
    'mcp_servers.runweave-evolution.bearer_token_env_var="RUNWEAVE_EVOLUTION_MCP_TOKEN"',
  ];
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "localhost"
  );
}
