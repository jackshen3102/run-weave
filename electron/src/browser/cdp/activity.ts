const MCP_ACTIVITY_COMMAND_PREFIXES = ["Input."] as const;

const MCP_ACTIVITY_COMMANDS = new Set([
  "Page.close",
  "Page.navigate",
  "Page.reload",
  "Page.setDocumentContent",
  "Page.stopLoading",
]);

export function shouldMarkTerminalBrowserMcpActivity(method: string): boolean {
  if (MCP_ACTIVITY_COMMANDS.has(method)) {
    return true;
  }
  return MCP_ACTIVITY_COMMAND_PREFIXES.some((prefix) =>
    method.startsWith(prefix),
  );
}
