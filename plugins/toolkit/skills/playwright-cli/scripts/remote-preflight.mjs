#!/usr/bin/env node
import { readFileSync } from "node:fs";

const stages = ["identity", "binding", "cdp", "proxy"];
const statuses = new Set(["passed", "failed", "skipped"]);
const args = process.argv.slice(2);

try {
  if (args.length !== 1)
    throw new Error("Expected one doctor-report.json path, or - for stdin");
  const report = JSON.parse(
    readFileSync(args[0] === "-" ? 0 : args[0], "utf8"),
  );
  if (
    report.schemaVersion !== 1 ||
    report.scope !== "terminal-browser-control" ||
    typeof report.healthy !== "boolean" ||
    !Array.isArray(report.checks) ||
    report.checks.length !== stages.length ||
    stages.some((stage, index) => {
      const check = report.checks[index];
      return (
        check?.stage !== stage ||
        !statuses.has(check.status) ||
        (check.code !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(check.code))
      );
    })
  )
    throw new Error("Expected a schemaVersion 1 browser doctor report");

  const ready =
    report.healthy && report.checks.every((check) => check.status === "passed");
  const failed = report.checks.find((check) => check.status === "failed");
  const missingIdentity = report.checks[0].status === "skipped";
  const preparation =
    missingIdentity || failed?.code === "BROWSER_BINDING_REQUIRED";
  const status = ready
    ? "control_ready"
    : preparation
      ? "preparation_required"
      : "control_failed";
  console.log(
    JSON.stringify(
      {
        status,
        stage: missingIdentity ? "identity" : (failed?.stage ?? null),
        code: missingIdentity
          ? "TERMINAL_IDENTITY_REQUIRED"
          : (failed?.code ?? null),
        pageVerified: false,
        acceptance: {
          existingOwnerPreservation: "not_checked",
          temporaryTerminalPreparation: report.checks
            .slice(0, 2)
            .every((check) => check.status === "passed")
            ? "ready"
            : preparation
              ? "incomplete"
              : "not_verified",
          cdpPageVerification: "not_run",
        },
        cleanup: {
          temporaryTerminalDeleted: "not_checked",
          originalPageRestored: "not_checked",
        },
        nextAction: ready
          ? "resolve_attach_and_verify_page"
          : preparation
            ? "prepare_target_terminal_identity_and_desktop_binding"
            : "diagnose_original_channel_without_rebinding",
      },
      null,
      2,
    ),
  );
  process.exitCode = ready ? 0 : preparation ? 2 : 3;
} catch {
  // Do not echo input or peer errors: a malformed report may contain credentials.
  console.error(
    "Invalid preflight input. Usage: node remote-preflight.mjs <doctor-report.json|->",
  );
  process.exitCode = 1;
}
