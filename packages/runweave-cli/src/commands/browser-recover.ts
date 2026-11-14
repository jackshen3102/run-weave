import type { BrowserRecoveryReport } from "@runweave/shared/browser-diagnostics";
import { CliError } from "../errors.js";
import { diagnoseBrowser } from "./browser-doctor.js";
import { parseResolveOptions, requestBrowserRecovery, type BrowserCommandIo } from "./browser-profile.js";

export async function runBrowserRecoverCommand(args: string[], io: BrowserCommandIo): Promise<void> {
  const options = parseResolveOptions(args, 60000);
  const deadline = Date.now() + (options.waitTimeoutMs || 5000);
  const attemptArgs = args.filter((arg, index) => arg !== "--wait-timeout-ms" && args[index - 1] !== "--wait-timeout-ms");
  attemptArgs.push("--wait-timeout-ms", "0");
  const boundedIo = { ...io, deadline };
  let report: BrowserRecoveryReport = { ...await diagnoseBrowser(attemptArgs, boundedIo), action: "none" };
  let requestId: string | undefined;
  while ((!report.healthy || report.action === "requested" && report.recoveryStatus !== "complete") && Date.now() < deadline) {
    const failure = report.checks.find(check => check.status === "failed");
    if (/BROWSER_SCOPE_DENIED|BROWSER_BINDING_REQUIRED|BROWSER_BINDING_CONFLICT|AUTOMATION_PROFILE_CONFLICT|REMOTE_CAPABILITY_UNSUPPORTED|NEEDS_AUTH|CONFIG_/.test(failure?.code ?? "")) break;
    // Retry temporary identity failures before asking the Backend to mutate a
    // channel. Never send a recovery request with unverified terminal identity.
    if (failure?.stage !== "identity") {
      try {
        const accepted = await requestBrowserRecovery(attemptArgs, boundedIo, requestId);
        if (!requestId) io.stderr.write("Browser recovery requested for the selected desktop; waiting for its control channel.\n");
        requestId = accepted.requestId;
        report.action = "requested";
        report.recoveryStatus = accepted.status;
      } catch (error) {
        report.recoveryCode = error instanceof Error
          ? error.message.match(/^[A-Z][A-Z0-9_]+(?=:|\s|$)/)?.[0] ?? "BROWSER_RECOVERY_UNAVAILABLE"
          : "BROWSER_RECOVERY_UNAVAILABLE";
        break;
      }
    }
    if (!options.waitTimeoutMs || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    report = { ...await diagnoseBrowser(attemptArgs, boundedIo), action: report.action, recoveryStatus: report.recoveryStatus };
  }
  if (report.action === "requested" && report.recoveryStatus !== "complete") {
    report.healthy = false;
    report.recoveryCode ??= "BROWSER_RECOVERY_PENDING";
  }
  io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.healthy) throw new CliError("Browser recovery did not restore the selected desktop; see checks in the report", 3);
}
