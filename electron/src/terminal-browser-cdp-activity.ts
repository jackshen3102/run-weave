const QUIET_CDP_COMMAND_PREFIXES = ["Tracing.", "Log.", "Network."] as const;

const QUIET_CDP_COMMANDS = new Set([
  "DOM.getDocument",
  "Emulation.setEmulatedMedia",
  "Emulation.setFocusEmulationEnabled",
  "Network.enable",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.setLifecycleEventsEnabled",
  "Performance.enable",
  "Runtime.enable",
  "Runtime.runIfWaitingForDebugger",
  "Target.setAutoAttach",
  "Target.getTargetInfo",
]);

export function shouldMarkTerminalBrowserMcpActivity(method: string): boolean {
  if (QUIET_CDP_COMMANDS.has(method)) {
    return false;
  }
  return !QUIET_CDP_COMMAND_PREFIXES.some((prefix) => method.startsWith(prefix));
}
