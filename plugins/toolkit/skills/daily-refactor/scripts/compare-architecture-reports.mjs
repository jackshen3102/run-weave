#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error(
    "Usage: compare-architecture-reports.mjs <before-report.json> <after-report.json>",
  );
  process.exit(2);
}

const before = await readReport(beforePath);
const after = await readReport(afterPath);
const failures = [];
const improvements = [];

const hardZeroMetrics = [
  "filesOver600",
  "runtimeCycles",
  "typeOnlyCycles",
  "forbiddenImports",
  "sharedRootImports",
  "errors",
];
const softRatchetMetrics = [
  "filesFrom500To600",
  "propsAtLeast10",
  "componentCallsAtLeast10",
  "functionsAtLeast200",
];

for (const metric of hardZeroMetrics) {
  const value = readMetric(after, metric);
  if (value !== 0) {
    failures.push(`Hard metric ${metric} must be 0; received ${value}.`);
  }
}

for (const metric of softRatchetMetrics) {
  const beforeValue = readMetric(before, metric);
  const afterValue = readMetric(after, metric);
  if (afterValue > beforeValue) {
    failures.push(
      `Soft metric ${metric} regressed: ${beforeValue} -> ${afterValue}.`,
    );
  } else if (afterValue < beforeValue) {
    improvements.push(`${metric}: ${beforeValue} -> ${afterValue}`);
  }
}

compareHotspots({
  label: "near-limit file",
  beforeItems: before.fileSize?.nearLimit,
  afterItems: after.fileSize?.nearLimit,
  keyOf: (item) => item.file,
  severityOf: (item) => item.lines,
});
compareHotspots({
  label: "large props type",
  beforeItems: before.react?.propsAtLeast10,
  afterItems: after.react?.propsAtLeast10,
  keyOf: namedHotspotKey,
  severityOf: (item) => item.count,
});
compareHotspots({
  label: "large component call",
  beforeItems: before.react?.componentCallsAtLeast10,
  afterItems: after.react?.componentCallsAtLeast10,
  keyOf: namedHotspotKey,
  severityOf: (item) => item.count,
});
compareHotspots({
  label: "long function",
  beforeItems: before.react?.functionsAtLeast200,
  afterItems: after.react?.functionsAtLeast200,
  keyOf: namedHotspotKey,
  severityOf: (item) => item.lines,
});

console.log(
  `architecture ratchet: before=${formatSummary(before)} after=${formatSummary(after)}`,
);
if (improvements.length > 0) {
  console.log(`architecture ratchet: improvements: ${improvements.join("; ")}`);
}
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`architecture ratchet: error: ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("architecture ratchet: pass");
}

async function readReport(filePath) {
  const resolved = path.resolve(filePath);
  const report = JSON.parse(await readFile(resolved, "utf8"));
  if (report?.schemaVersion !== 1 || !report.summary) {
    throw new Error(`Unsupported architecture report: ${resolved}`);
  }
  return report;
}

function readMetric(report, metric) {
  const value = report.summary[metric];
  if (!Number.isFinite(value)) {
    throw new Error(`Architecture report is missing numeric metric: ${metric}`);
  }
  return value;
}

function namedHotspotKey(item) {
  return `${item.file}:${item.name || `line-${item.line}`}`;
}

function compareHotspots({
  label,
  beforeItems = [],
  afterItems = [],
  keyOf,
  severityOf,
}) {
  const beforeByKey = indexHotspots(beforeItems, keyOf, severityOf);
  const afterByKey = indexHotspots(afterItems, keyOf, severityOf);

  for (const [key, item] of afterByKey) {
    const previous = beforeByKey.get(key);
    const severity = severityOf(item);
    if (!previous) {
      failures.push(`New ${label}: ${key} (${severity}).`);
      continue;
    }
    const previousSeverity = severityOf(previous);
    if (severity > previousSeverity) {
      failures.push(
        `${label} worsened: ${key} ${previousSeverity} -> ${severity}.`,
      );
    } else if (severity < previousSeverity) {
      improvements.push(`${label} ${key}: ${previousSeverity} -> ${severity}`);
    }
  }

  for (const [key, item] of beforeByKey) {
    if (!afterByKey.has(key)) {
      improvements.push(`${label} removed: ${key} (${severityOf(item)})`);
    }
  }
}

function indexHotspots(items, keyOf, severityOf) {
  const indexed = new Map();
  for (const item of items ?? []) {
    const key = keyOf(item);
    const current = indexed.get(key);
    if (!current || severityOf(item) > severityOf(current)) {
      indexed.set(key, item);
    }
  }
  return indexed;
}

function formatSummary(report) {
  return [...hardZeroMetrics, ...softRatchetMetrics]
    .map((metric) => `${metric}=${readMetric(report, metric)}`)
    .join(",");
}
