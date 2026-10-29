import type { BrowserProxyState } from "@runweave/shared/browser-proxy-control";
import { getStringOption, parseArgs, requireStringOption } from "../args.js";
import { BrowserCdpClient } from "../client/browser-cdp.js";
import { CliError } from "../errors.js";
import { resolveBrowserProfile, type BrowserCommandIo } from "./browser-profile.js";

export async function runBrowserProxyCommand(args: string[], io: BrowserCommandIo): Promise<void> {
  const [command, ...rest] = args;
  const usage = "Usage: rw browser proxy status | rw browser proxy set --mode direct|whistle [--profile 1|2|3] [--group-id <id>] [--json]";
  if (command !== "status" && command !== "set") throw new CliError(usage, 2);
  const { options, positionals } = parseArgs(rest, new Set(["json"]));
  const allowed = new Set(["profile", "group-id", "json", ...(command === "set" ? ["mode"] : [])]);
  if (positionals.length || Object.keys(options).some(key => !allowed.has(key))) throw new CliError(usage, 2);
  const mode = command === "set" ? requireStringOption(options, "mode") : undefined;
  if (mode && mode !== "direct" && mode !== "whistle") throw new CliError("--mode must be direct or whistle", 2);
  const profileArgs = ["profile", "group-id"].flatMap(key => {
    const value = getStringOption(options, key);
    return value ? [`--${key}`, value] : [];
  });
  const resolved = await resolveBrowserProfile(profileArgs, io);
  const cdp = await BrowserCdpClient.connect(resolved.cdpEndpoint);
  try {
    let result = await cdp.send<BrowserProxyState>("Runweave.getProxyState");
    if (!result || !["direct", "whistle"].includes(result.proxyMode) || typeof result.effectiveProxy !== "string")
      throw new CliError("Desktop proxy control is unavailable; update the desktop", 3);
    if (mode) result = await cdp.send<BrowserProxyState>("Runweave.setProxyMode", { mode, expectedMode: result.proxyMode });
    if (mode && (result.proxyMode !== mode || result.applyError))
      throw new CliError("Desktop proxy changed or failed to apply; inspect proxy status before retrying", 4);
    io.stdout.write(`${JSON.stringify({ ...result, browserGroupId: resolved.browserGroupId }, null, 2)}\n`);
  } finally { cdp.close(); }
}
