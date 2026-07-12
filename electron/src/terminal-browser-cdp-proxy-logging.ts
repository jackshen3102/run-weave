// CDP traffic can contain thousands of messages per second. Keep per-message
// logging opt-in so diagnostics cannot monopolize the Electron main process.
export const CDP_PROXY_TRACE_ENABLED =
  process.env.TERMINAL_BROWSER_CDP_LOGS === "true";
