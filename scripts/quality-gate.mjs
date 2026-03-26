import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, "artifacts");
const REPORT_PATH = path.join(ARTIFACT_DIR, "quality-report.json");
const ALL_STEPS = [
  {
    id: "shared-typecheck",
    command: ["pnpm", "--filter", "./packages/shared", "typecheck"],
    tags: ["shared", "contract"],
    critical: true,
  },
  {
    id: "backend-typecheck",
    command: ["pnpm", "--filter", "./backend", "typecheck"],
    tags: ["backend", "contract"],
    critical: true,
  },
  {
    id: "backend-quality-tests",
    command: [
      "pnpm",
      "--filter",
      "./backend",
      "exec",
      "vitest",
      "run",
      "src/quality/probe-store.test.ts",
      "src/routes/quality.test.ts",
      "src/ws/navigation-handler.test.ts",
      "src/ws/session-control.test.ts",
    ],
    tags: ["backend", "quality"],
    critical: true,
  },
  {
    id: "frontend-smoke-e2e",
    command: [
      "pnpm",
      "--filter",
      "./frontend",
      "e2e",
      "--",
      "tests/smoke.spec.ts",
    ],
    tags: ["frontend", "quality"],
    critical: true,
  },
  {
    id: "frontend-interaction-e2e",
    command: [
      "pnpm",
      "--filter",
      "./frontend",
      "e2e",
      "--",
      "tests/interaction.spec.ts",
    ],
    tags: ["frontend", "quality", "critical-journey"],
    critical: true,
    maxAttempts: 2,
  },
];

function readChangedFiles() {
  const changedArg = process.argv.find((arg) => arg.startsWith("--changed="));
  if (changedArg) {
    return changedArg
      .slice("--changed=".length)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  const result = spawnSync("git", ["diff", "--name-only"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isCriticalJourneyFile(filePath) {
  return [
    "backend/src/ws/",
    "backend/src/routes/test.ts",
    "backend/src/routes/quality.ts",
    "backend/src/quality/",
    "backend/src/session/",
    "frontend/src/pages/home/",
    "frontend/src/App.tsx",
    "frontend/tests/smoke.spec.ts",
    "frontend/src/features/viewer/",
    "frontend/src/components/viewer",
    "frontend/src/components/viewer-page.tsx",
    "frontend/tests/interaction.spec.ts",
    "frontend/playwright.config.ts",
    "packages/shared/src/",
  ].some((prefix) => filePath.startsWith(prefix));
}

function selectSteps(changedFiles) {
  if (changedFiles.length === 0) {
    return {
      selectedSteps: ALL_STEPS,
      selectionReason: "No changed files detected; ran full quality gate.",
      riskLevel: "full",
    };
  }

  const touchesShared = changedFiles.some((filePath) =>
    filePath.startsWith("packages/shared/"),
  );
  const touchesCriticalJourney = changedFiles.some(isCriticalJourneyFile);
  const touchesBackend = changedFiles.some((filePath) =>
    filePath.startsWith("backend/"),
  );
  const touchesFrontend = changedFiles.some((filePath) =>
    filePath.startsWith("frontend/"),
  );

  if (touchesShared || touchesCriticalJourney) {
    return {
      selectedSteps: ALL_STEPS,
      selectionReason:
        "Changed files touch shared contracts or critical viewer journey code.",
      riskLevel: "full",
    };
  }

  if (touchesBackend) {
    return {
      selectedSteps: ALL_STEPS.filter((step) => step.tags.includes("backend")),
      selectionReason: "Changed files are backend-only and outside critical viewer paths.",
      riskLevel: "reduced",
    };
  }

  if (touchesFrontend) {
    return {
      selectedSteps: ALL_STEPS.filter((step) => step.tags.includes("frontend")),
      selectionReason: "Changed files are frontend-only and outside shared/backend contracts.",
      riskLevel: "reduced",
    };
  }

  return {
    selectedSteps: [],
    selectionReason: "No code paths mapped to the quality harness were changed.",
    riskLevel: "minimal",
  };
}

function classifyFailure(stepResult) {
  const combinedOutput = `${stepResult.stdout}\n${stepResult.stderr}`;

  if (
    /listen EPERM|EADDRINUSE|Process from config\.webServer was not able to start|Server is not running/i.test(
      combinedOutput,
    )
  ) {
    return "fail_env_noise";
  }

  return "fail_product_bug";
}

function buildEvidence(results) {
  return results
    .filter(
      (result) =>
        result.status === "passed" || result.status === "passed_after_retry",
    )
    .map((result) =>
      result.status === "passed_after_retry"
        ? `${result.id} passed after retry (${result.attempts.length} attempts)`
        : `${result.id} passed`,
    );
}

function buildRiskSummary(results, skippedCriticalSteps, selection) {
  const risks = [];

  for (const result of results) {
    if (result.status === "passed_after_retry") {
      risks.push(
        `${result.id} passed after retry (${result.attempts.length} attempts)`,
      );
    }
  }

  if (selection.riskLevel !== "full") {
    risks.push(`Reduced gate selection: ${selection.selectionReason}`);
  }

  if (skippedCriticalSteps.length > 0) {
    risks.push(`Skipped critical steps: ${skippedCriticalSteps.join(", ")}`);
  }

  return risks;
}

function runStep(step) {
  const [cmd, ...args] = step.command;
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  const endedAt = new Date().toISOString();

  return {
    id: step.id,
    command: step.command.join(" "),
    startedAt,
    endedAt,
    exitCode: result.status ?? 1,
    status: result.status === 0 ? "passed" : "failed",
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runStepWithRetries(step) {
  const attempts = [];
  const maxAttempts = step.maxAttempts ?? 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = runStep(step);
    attempts.push({
      ...result,
      attempt,
    });

    if (result.status === "passed") {
      if (attempt > 1) {
        return {
          ...result,
          attempt,
          status: "passed_after_retry",
          attempts,
        };
      }
      return {
        ...result,
        attempt,
        attempts,
      };
    }
  }

  const lastAttempt = attempts.at(-1);
  return {
    ...lastAttempt,
    attempts,
  };
}

function stripAttemptOutput(attempt) {
  return {
    id: attempt.id,
    command: attempt.command,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    exitCode: attempt.exitCode,
    status: attempt.status,
    attempt: attempt.attempt,
  };
}

function toReportStep(result) {
  return {
    id: result.id,
    command: result.command,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    exitCode: result.exitCode,
    status: result.status,
    attempt: result.attempt,
    retrySummary:
      result.attempts.length > 1
        ? {
            attempts: result.attempts.length,
            finalStatus: result.status,
          }
        : null,
    attempts: result.attempts.map(stripAttemptOutput),
  };
}

const changedFiles = readChangedFiles();
const selection = selectSteps(changedFiles);
const results = [];

for (const step of selection.selectedSteps) {
  const result = runStepWithRetries(step);
  results.push(result);
  if (result.status === "failed") {
    break;
  }
}

const failed = results.find((result) => result.status === "failed");
const skippedCriticalSteps = ALL_STEPS.filter(
  (step) =>
    step.critical &&
    !selection.selectedSteps.some((selectedStep) => selectedStep.id === step.id),
).map((step) => step.id);

let verdict = "pass";
if (failed) {
  verdict = classifyFailure(failed);
} else if (results.some((result) => result.status === "passed_after_retry")) {
  verdict = "pass_with_risk";
} else if (selection.riskLevel !== "full" || skippedCriticalSteps.length > 0) {
  verdict = "pass_with_risk";
}

const evidence = buildEvidence(results);
const riskSummary = buildRiskSummary(results, skippedCriticalSteps, selection);

const report = {
  verdict,
  generatedAt: new Date().toISOString(),
  changedFiles,
  selectionReason: selection.selectionReason,
  riskSummary,
  evidence,
  skippedCriticalSteps,
  steps: results.map(toReportStep),
  failedStepId: failed?.id ?? null,
};

await mkdir(ARTIFACT_DIR, { recursive: true });
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

globalThis.console.log(JSON.stringify(report, null, 2));

if (failed) {
  process.exit(1);
}
