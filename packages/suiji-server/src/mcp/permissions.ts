import { ServiceError } from "../errors";

export type McpScope = "read-only" | "read-write";
export function requireMcpWrite(scope: McpScope) {
  if (scope !== "read-write")
    throw new ServiceError(403, "FORBIDDEN", "此 MCP 凭据仅允许读取");
}
