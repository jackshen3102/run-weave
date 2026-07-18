export {
  terminalBrowserEvents,
  type TerminalBrowserCdpTarget,
  type TerminalBrowserTabSnapshot,
  type TerminalBrowserUpdate,
} from "./terminal-browser-runtime.js";
export { closeTerminalBrowsersForWindow } from "./terminal-browser-view-lifecycle.js";
export {
  activateTerminalBrowserTabFromProxy,
  closeTerminalBrowserTabFromProxy,
  createTerminalBrowserTabFromProxy,
  getTerminalBrowserCdpTargets,
  getTerminalBrowserEntryByKey,
  getTerminalBrowserEntryByTargetId,
  getTerminalBrowserDisplayScaleForTarget,
  getTerminalBrowserTabsForWindow,
  markTerminalBrowserMcpActivity,
  setTerminalBrowserCdpProxyAttached,
  setTerminalBrowserDisplayScaleForTarget,
} from "./terminal-browser-proxy-api.js";
export { registerTerminalBrowserHandlers } from "./terminal-browser-handlers.js";
