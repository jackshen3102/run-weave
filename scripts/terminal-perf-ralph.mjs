#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_ITERATIONS = 5;

function readOption(name, fallback) {
  const flag = `--${name}=`;
  const match = process.argv.slice(2).find((arg) => arg.startsWith(flag));
  return match ? match.slice(flag.length) : fallback;
}

function readPositiveIntOption(name, fallback) {
  const value = Number.parseInt(readOption(name, ""), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue))
  ];
}

function summarize(values) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(2)),
    p95: Number(percentile(values, 0.95).toFixed(2)),
    max: Number((values.length ? Math.max(...values) : 0).toFixed(2)),
  };
}

function countOccurrences(text, pattern) {
  return (text.match(pattern) ?? []).length;
}

function runIteration({ candidate, commit, rootDir, iteration }) {
  const iterationDir = path.join(rootDir, candidate, `iteration-${iteration}`);
  mkdirSync(iterationDir, { recursive: true });

  const env = {
    ...process.env,
    TERMINAL_PERF: "1",
    TERMINAL_PERF_CANDIDATE: candidate,
    TERMINAL_PERF_COMMIT: commit,
    TERMINAL_PERF_ARTIFACT_DIR: iterationDir,
  };
  const result = spawnSync(
    "pnpm",
    ["--filter", "./frontend", "e2e", "--", "tests/terminal-performance.spec.ts"],
    {
      cwd: process.cwd(),
      env,
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(path.join(iterationDir, "playwright-output.log"), output, "utf8");

  const artifactPath = path.join(iterationDir, `${candidate}.json`);
  const payload = JSON.parse(readFileSync(artifactPath, "utf8"));
  const enriched = {
    ...payload,
    runnerFrontendPerfLogCount: countOccurrences(output, /\[terminal-perf-fe\]/g),
    exitCode: result.status,
  };
  writeFileSync(artifactPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");

  if (result.status !== 0) {
    throw new Error(
      `terminal performance iteration ${iteration} failed with exit ${result.status}; see ${iterationDir}`,
    );
  }

  return enriched;
}

function main() {
  const candidate = readOption("candidate", process.env.TERMINAL_PERF_CANDIDATE ?? "baseline");
  const iterations = readPositiveIntOption("iterations", DEFAULT_ITERATIONS);
  const rootDir = path.resolve(
    readOption(
      "artifact-dir",
      path.join("artifacts", "terminal-perf", new Date().toISOString().replaceAll(":", "-")),
    ),
  );
  const commit =
    readOption("commit", process.env.TERMINAL_PERF_COMMIT ?? "") ||
    spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).stdout.trim();

  mkdirSync(path.join(rootDir, candidate), { recursive: true });
  const results = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    console.info(`[terminal-perf-ralph] ${candidate} iteration ${iteration}/${iterations}`);
    results.push(runIteration({ candidate, commit, rootDir, iteration }));
  }

  const summary = {
    candidate,
    commit,
    iterations,
    artifactDir: path.join(rootDir, candidate),
    echoLatencyP50AcrossRuns: summarize(
      results.map((result) => result.echoLatencyMs.p50),
    ),
    echoLatencyP95AcrossRuns: summarize(
      results.map((result) => result.echoLatencyMs.p95),
    ),
    outputReceivedSinceLastInputP50AcrossRuns: summarize(
      results.map((result) => result.outputReceivedSinceLastInputMs.p50),
    ),
    outputReceivedSinceLastInputP95AcrossRuns: summarize(
      results.map((result) => result.outputReceivedSinceLastInputMs.p95),
    ),
    outputRenderedSinceLastInputP50AcrossRuns: summarize(
      results.map((result) => result.outputRenderedSinceLastInputMs.p50),
    ),
    outputRenderedSinceLastInputP95AcrossRuns: summarize(
      results.map((result) => result.outputRenderedSinceLastInputMs.p95),
    ),
    outputRenderDurationP95AcrossRuns: summarize(
      results.map((result) => result.outputRenderDurationMs.p95),
    ),
    outputPaintedSinceLastInputP50AcrossRuns: summarize(
      results.map((result) => result.outputPaintedSinceLastInputMs.p50),
    ),
    outputPaintedSinceLastInputP95AcrossRuns: summarize(
      results.map((result) => result.outputPaintedSinceLastInputMs.p95),
    ),
    outputPaintDelayP95AcrossRuns: summarize(
      results.map((result) => result.outputPaintDelayMs.p95),
    ),
    openDurationMsAcrossRuns: summarize(
      results.map((result) => result.openDurationMs),
    ),
    longTaskCountAcrossRuns: summarize(
      results.map((result) => result.longTasks.count),
    ),
    frontendPerfLogCountAcrossRuns: summarize(
      results.map((result) => result.frontendPerfLogCount),
    ),
  };
  const summaryPath = path.join(rootDir, candidate, "summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.info("[terminal-perf-ralph] summary", summaryPath);
  console.info(JSON.stringify(summary, null, 2));
}

main();
