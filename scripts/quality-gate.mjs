import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const ARTIFACT_DIR = path.join(ROOT, "artifacts");
const REPORT_PATH = path.join(ARTIFACT_DIR, "quality-report.json");
const LAYER_ORDER = ["default", "e2e", "live"];
const LAYER_STEP_IDS = {
  default: ["default-tests", "quality-gate-self-test"],
  e2e: ["e2e-smoke", "e2e-interaction"],
  live: ["live-smoke"],
};

const ALL_STEPS = [
  {
    id: "default-tests",
    command: ["pnpm", "run", "test:default"],
    layers: ["default"],
    critical: true,
  },
  {
    id: "e2e-smoke",
    command: ["pnpm", "--filter", "./frontend", "e2e", "--", "tests/smoke.spec.ts"],
    layers: ["e2e"],
    critical: true,
  },
  {
    id: "e2e-interaction",
    command: [
      "pnpm",
      "--filter",
      "./frontend",
      "e2e",
      "--",
      "tests/interaction.spec.ts",
    ],
    layers: ["e2e"],
    critical: true,
    maxAttempts: 2,
  },
  {
    id: "live-smoke",
    command: ["pnpm", "run", "test:live"],
    layers: ["live"],
    critical: false,
  },
  {
    id: "quality-gate-self-test",
    command: ["node", "scripts/quality-gate.test.mjs"],
    layers: ["default"],
    critical: true,
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

function isLiveInfraFile(filePath) {
  return (
    filePath.startsWith("backend/src/live/") ||
    filePath === "backend/vitest.live.config.ts" ||
    filePath === "backend/.env.example" ||
    filePath === "backend/package.json"
  );
}

function isQualityGateFile(filePath) {
  return (
    filePath === "scripts/quality-gate.mjs" ||
    filePath === "scripts/quality-gate.test.mjs"
  );
}

function isRootQualityInfraFile(filePath) {
  return filePath === "package.json" || filePath === "pnpm-lock.yaml";
}

function expandStepsForLayers(layers) {
  const stepIds = layers.flatMap((layer) => LAYER_STEP_IDS[layer] ?? []);
  const selected = [];

  for (const stepId of stepIds) {
    const found = ALL_STEPS.find((step) => step.id === stepId);
    if (!found) {
      continue;
    }
    if (!selected.some((step) => step.id === found.id)) {
      selected.push(found);
    }
  }

  return selected;
}

export function selectLayersForChangedFiles(changedFiles) {
  if (changedFiles.length === 0) {
    return [...LAYER_ORDER];
  }

  const layers = new Set();
  const touchesShared = changedFiles.some((filePath) =>
    filePath.startsWith("packages/shared/"),
  );
  const touchesRootQualityInfra = changedFiles.some(isRootQualityInfraFile);
  const touchesCriticalJourney = changedFiles.some(isCriticalJourneyFile);
  const touchesLive = changedFiles.some(isLiveInfraFile);
  const touchesQualityGate = changedFiles.some(isQualityGateFile);
  const touchesBackend = changedFiles.some((filePath) =>
    filePath.startsWith("backend/"),
  );
  const touchesFrontend = changedFiles.some((filePath) =>
    filePath.startsWith("frontend/"),
  );
  const touchesE2EInfra = changedFiles.some(
    (filePath) =>
      filePath.startsWith("frontend/tests/") ||
      filePath === "frontend/playwright.config.ts",
  );

  if (touchesShared || touchesCriticalJourney) {
    layers.add("default");
    layers.add("e2e");
  }

  if (touchesRootQualityInfra) {
    layers.add("default");
    layers.add("e2e");
    layers.add("live");
  }

  if (touchesLive) {
    layers.add("live");
  }

  if (touchesBackend) {
    layers.add("default");
  }

  if (touchesFrontend) {
    layers.add("e2e");
  }

  if (touchesE2EInfra) {
    layers.add("e2e");
  }

  if (touchesQualityGate) {
    layers.add("default");
  }

  return LAYER_ORDER.filter((layer) => layers.has(layer));
}

export function selectStepsForChangedFiles(changedFiles) {
  const selectedLayers = selectLayersForChangedFiles(changedFiles);
  const touchesQualityGate = changedFiles.some(isQualityGateFile);

  if (changedFiles.length === 0) {
    return {
      selectedLayers,
      selectedSteps: expandStepsForLayers(selectedLayers),
      selectionReason: "No changed files detected; ran full layered quality gate.",
      riskLevel: "full",
    };
  }

  if (selectedLayers.length === 0) {
    return {
      selectedLayers,
      selectedSteps: [],
      selectionReason: "No code paths mapped to the layered quality harness were changed.",
      riskLevel: "minimal",
    };
  }

  const isFull =
    selectedLayers.includes("default") &&
    selectedLayers.includes("e2e");
  const selectedSteps = expandStepsForLayers(selectedLayers);

  if (touchesQualityGate) {
    const selfTestStep = ALL_STEPS.find(
      (step) => step.id === "quality-gate-self-test",
    );
    if (
      selfTestStep &&
      !selectedSteps.some((step) => step.id === selfTestStep.id)
    ) {
      selectedSteps.push(selfTestStep);
    }
  }

  return {
    selectedLayers,
    selectedSteps,
    selectionReason: `Selected layers: ${selectedLayers.join(", ")}.`,
    riskLevel: isFull ? "full" : "reduced",
  };
}

function classifyFailure(stepResult) {
  const combinedOutput = `${stepResult.stdout}\n${stepResult.stderr}`;

  if (
    /listen EPERM|EADDRINUSE|Process from config\.webServer was not able to start|Server is not running|failed to allocate remote debugging port/i.test(
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

function buildStepEnv(baseEnv) {
  const nextEnv = { ...baseEnv };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
  ]) {
    delete nextEnv[key];
  }
  return nextEnv;
}

function runStep(step) {
  const [cmd, ...args] = step.command;
  const startedAt = new Date().toISOString();
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    env: buildStepEnv(process.env),
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

export async function runQualityGate() {
  const changedFiles = readChangedFiles();
  const selection = selectStepsForChangedFiles(changedFiles);
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
    selectedLayers: selection.selectedLayers,
    selectionReason: selection.selectionReason,
    riskSummary,
    evidence,
    skippedCriticalSteps,
    steps: results.map(toReportStep),
    failedStepId: failed?.id ?? null,
  };

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));

  return {
    failed,
    report,
  };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const { failed, report } = await runQualityGate();
  globalThis.console.log(JSON.stringify(report, null, 2));

  if (failed && report.verdict === "fail_product_bug") {
    process.exit(1);
  }
}
