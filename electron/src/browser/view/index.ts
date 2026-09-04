export {
  terminalBrowserEvents,
  type TerminalBrowserCdpTarget,
  type TerminalBrowserTabSnapshot,
  type TerminalBrowserUpdate,
} from "../runtime.js";
export { closeTerminalBrowsersForWindow } from "./lifecycle.js";
export {
  activateTerminalBrowserTabFromProxy,
  closeTerminalBrowserTabFromProxy,
  createTerminalBrowserTabFromProxy,
  getTerminalBrowserCdpTargets,
  getTerminalBrowserEntryByKey,
  getTerminalBrowserEntryByTargetId,
  getTerminalBrowserDisplayScaleForTarget,
  markTerminalBrowserMcpActivity,
  setTerminalBrowserCdpProxyAttached,
  setTerminalBrowserDisplayScaleForTarget,
} from "../proxy/api.js";
export { registerTerminalBrowserHandlers } from "../handlers.js";
