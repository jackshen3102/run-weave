#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  aggregateCase,
  buildPrompt,
  OUTPUT_SCHEMA,
  REVIEWERS,
  validateManifest,
  validateReview,
} from "./static-review-contract.mjs";

function usage() {
  return [
    "Usage:",
    "  node run-static-review.mjs --manifest=<file> --output=<dir> [--prepare-only] [--timeout-ms=<ms>]",
    "",
    "The manifest contract is documented in references/contracts.md.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    manifest: null,
    output: null,
    prepareOnly: false,
    timeoutMs: 12 * 60 * 1000,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg === "--prepare-only") {
      options.prepareOnly = true;
    } else if (arg.startsWith("--manifest=")) {
      options.manifest = path.resolve(arg.slice("--manifest=".length));
    } else if (arg.startsWith("--output=")) {
      options.output = path.resolve(arg.slice("--output=".length));
    } else if (arg.startsWith("--timeout-ms=")) {
      options.timeoutMs = Number.parseInt(
        arg.slice("--timeout-ms=".length),
        10,
      );
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.manifest || !options.output) {
    throw new Error("--manifest and --output are required");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return options;
}

async function writePrivate(filePath, content) {
  await mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(filePath, content, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function reviewerArgs(reviewer, schemaPath, outputPath, sandboxDir) {
  return [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--ignore-user-config",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--sandbox",
    "read-only",
    "-C",
    sandboxDir,
    "-m",
    reviewer.model,
    "-c",
    'model_reasoning_effort="high"',
    "--output-schema",
    schemaPath,
    "--json",
    "--output-last-message",
    outputPath,
    "-",
  ];
}

async function runCommand(command, args, input, timeoutMs) {
  const startedAt = Date.now();
  const child = spawn(command, args, {
    env: {
      ...process.env,
      NO_COLOR: "1",
      TERM: "dumb",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, timeoutMs);
  const status = await new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ exitCode: null, signal: null, spawnError: error.message });
    });
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, spawnError: null });
    });
  });
  clearTimeout(timer);
  return {
    ...status,
    timedOut,
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
  };
}

function parseJsonLines(stdout) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function parseStructuredValue(value) {
  const trimmed = value.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

async function readReviewerResult(outputPath, stdout) {
  try {
    return parseStructuredValue(await readFile(outputPath, "utf8"));
  } catch {
    const agentMessage = parseJsonLines(stdout)
      .slice()
      .reverse()
      .find(
        (item) =>
          item.type === "item.completed" &&
          item.item?.type === "agent_message" &&
          typeof item.item.text === "string",
      );
    if (!agentMessage) {
      throw new Error("reviewer produced no parseable result");
    }
    return parseStructuredValue(agentMessage.item.text);
  }
}

async function invokeReviewer({
  reviewer,
  testCase,
  prompt,
  outputDir,
  schemaPath,
  sandboxDir,
  timeoutMs,
}) {
  const prefix = `${testCase.id}-${reviewer.id}`;
  await writePrivate(path.join(outputDir, "prompts", `${prefix}.txt`), prompt);
  let lastReceipt = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptPrefix = `${prefix}-attempt-${attempt}`;
    const resultPath = path.join(
      outputDir,
      "raw",
      `${attemptPrefix}.result.json`,
    );
    await mkdir(path.dirname(resultPath), {
      recursive: true,
      mode: 0o700,
    });
    const commandResult = await runCommand(
      reviewer.command,
      reviewerArgs(reviewer, schemaPath, resultPath, sandboxDir),
      prompt,
      timeoutMs,
    );
    await writePrivate(
      path.join(outputDir, "raw", `${attemptPrefix}.stdout`),
      commandResult.stdout,
    );
    await writePrivate(
      path.join(outputDir, "raw", `${attemptPrefix}.stderr`),
      commandResult.stderr,
    );
    let review = null;
    let parseError = null;
    try {
      review = await readReviewerResult(resultPath, commandResult.stdout);
      validateReview(review, testCase);
      await writePrivate(resultPath, `${JSON.stringify(review, null, 2)}\n`);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
    lastReceipt = {
      caseId: testCase.id,
      reviewerId: reviewer.id,
      model: reviewer.model,
      attempt,
      ok:
        commandResult.exitCode === 0 && !commandResult.timedOut && !parseError,
      review,
      parseError,
      ...commandResult,
    };
    if (lastReceipt.ok) {
      return lastReceipt;
    }
  }
  return lastReceipt;
}

async function runQueue(tasks, concurrency, worker) {
  const results = new Array(tasks.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
      while (nextIndex < tasks.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await worker(tasks[index]);
      }
    }),
  );
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestDir = path.dirname(options.manifest);
  const manifest = validateManifest(
    JSON.parse(await readFile(options.manifest, "utf8")),
    manifestDir,
  );
  await mkdir(options.output, { recursive: true, mode: 0o700 });
  const sandboxDir = path.join(options.output, "empty-sandbox");
  await mkdir(sandboxDir, { recursive: true, mode: 0o700 });
  const schemaPath = path.join(options.output, "review.schema.json");
  await writePrivate(schemaPath, `${JSON.stringify(OUTPUT_SCHEMA, null, 2)}\n`);

  const preparedCases = [];
  for (const testCase of manifest.cases) {
    const patchText = await readFile(testCase.patchPath, "utf8");
    const prompt = buildPrompt(testCase, patchText);
    preparedCases.push({
      ...testCase,
      patchSha256: createHash("sha256").update(patchText).digest("hex"),
      prompt,
    });
    for (const reviewer of REVIEWERS) {
      await writePrivate(
        path.join(
          options.output,
          "prompts",
          `${testCase.id}-${reviewer.id}.txt`,
        ),
        prompt,
      );
    }
  }
  await writePrivate(
    path.join(options.output, "prepared.json"),
    `${JSON.stringify(
      {
        reviewers: REVIEWERS,
        cases: preparedCases.map((testCase) => ({
          id: testCase.id,
          requirements: testCase.requirements,
          patchPath: testCase.patchPath,
          patchSha256: testCase.patchSha256,
        })),
      },
      null,
      2,
    )}\n`,
  );
  if (options.prepareOnly) {
    process.stdout.write(
      `${JSON.stringify(
        {
          prepared: true,
          output: options.output,
          caseCount: preparedCases.length,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const tasks = preparedCases.flatMap((testCase) =>
    REVIEWERS.map((reviewer) => ({
      reviewer,
      testCase,
      prompt: testCase.prompt,
    })),
  );
  const receipts = await runQueue(tasks, REVIEWERS.length, (task) =>
    invokeReviewer({
      ...task,
      outputDir: options.output,
      schemaPath,
      sandboxDir,
      timeoutMs: options.timeoutMs,
    }),
  );
  const cases = preparedCases.map((testCase) =>
    aggregateCase(
      testCase,
      receipts.filter((receipt) => receipt.caseId === testCase.id),
    ),
  );
  const protocolFailures = receipts
    .filter((receipt) => !receipt.ok)
    .map((receipt) => ({
      caseId: receipt.caseId,
      reviewerId: receipt.reviewerId,
      model: receipt.model,
      attempts: receipt.attempt,
      exitCode: receipt.exitCode,
      timedOut: receipt.timedOut,
      spawnError: receipt.spawnError,
      parseError: receipt.parseError,
    }));
  const result = {
    version: 1,
    createdAt: new Date().toISOString(),
    reviewers: REVIEWERS,
    cases,
    protocolFailures,
    receipts,
  };
  await writePrivate(
    path.join(options.output, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: protocolFailures.length === 0,
        output: options.output,
        cases,
        protocolFailures,
      },
      null,
      2,
    )}\n`,
  );
  if (protocolFailures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
