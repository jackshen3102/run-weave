import type { BrowserDiagnosticReport, BrowserDiagnosticStage } from "@runweave/shared/browser-diagnostics";
import type { BrowserProxyState } from "@runweave/shared/browser-proxy-control";
import { BrowserCdpClient } from "../client/browser-cdp.js";
import { CliError } from "../errors.js";
import { readCliVersion } from "../version.js";
import { resolveBrowserProfile, type BrowserCommandIo } from "./browser-profile.js";

export async function runBrowserDoctorCommand(args: string[], io: BrowserCommandIo): Promise<void> {
  const report: BrowserDiagnosticReport = {
    schemaVersion: 1,
    scope: "terminal-browser-control",
    healthy: false,
    observedAt: new Date().toISOString(),
    cliVersion: readCliVersion().version,
    checks: (["identity", "binding", "cdp", "proxy"] as const).map(stage => ({ stage, status: "skipped" })),
    pageRequestsVerified: false,
  };
  let stage: BrowserDiagnosticStage = "identity";
  let cdp: BrowserCdpClient | undefined;
  let failure: unknown;
  const passed = (current: BrowserDiagnosticStage) => {
    report.checks.find(check => check.stage === current)!.status = "passed";
  };
  try {
    const resolved = await resolveBrowserProfile(args, {
      ...io,
      onBrowserStage(current, complete) {
        stage = current;
        if (complete) passed(current);
      },
    });
    report.profileId = resolved.profileId;
    if (!io.env.RUNWEAVE_TERMINAL_SESSION_ID?.trim()) {
      Object.assign(report.checks[0]!, { status: "skipped", code: "NO_TERMINAL_IDENTITY" });
    }
    stage = "cdp";
    cdp = await BrowserCdpClient.connect(resolved.cdpEndpoint);
    passed(stage);
    stage = "proxy";
    const state = await cdp.send<BrowserProxyState>("Runweave.getProxyState", {}, undefined, 5000);
    if (!state || !["direct", "whistle"].includes(state.proxyMode) || typeof state.effectiveProxy !== "string")
      throw new CliError("REMOTE_CAPABILITY_UNSUPPORTED: Desktop proxy state is unavailable", 3);
    if (state.profileId !== resolved.profileId) throw new CliError("BROWSER_SCOPE_DENIED: Proxy Profile differs from resolution", 4);
    report.proxyMode = state.proxyMode;
    report.effectiveProxy = state.effectiveProxy;
    if (state.applyError) throw new CliError(`${state.applyError.code}: Proxy settings were not applied`, 3);
    if (state.proxyMode === "whistle" && state.whistle?.status !== "ready")
      throw new CliError("WHISTLE_UNAVAILABLE: Profile proxy is not ready", 3);
    passed(stage);
    report.healthy = true;
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 2) throw error;
    failure = error;
    // Peer errors can contain URLs or credentials. Emit only a stable code.
    const code = error instanceof Error ? error.message.match(/^[A-Z][A-Z0-9_]+(?=:|\s|$)/)?.[0] : undefined;
    Object.assign(report.checks.find(check => check.stage === stage)!, {
      status: "failed", code: code ?? `BROWSER_${stage.toUpperCase()}_UNAVAILABLE`,
    });
  } finally {
    cdp?.close();
  }
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failure) throw new CliError(`Browser doctor failed at ${stage}; see checks in the report`, 3);
}
