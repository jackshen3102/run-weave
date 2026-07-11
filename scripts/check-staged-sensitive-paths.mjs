#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";

const MAX_FINDINGS = 20;
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const blockedKeyword = ["byte", "dance"].join("");
const macHomePrefix = "/" + "Users" + "/";
const linuxHomePrefix = "/" + "home" + "/";
const windowsUsersDir = "Users";

const rules = [
  {
    id: "company-keyword",
    description: "contains a blocked company-specific keyword",
    test: (value) => new RegExp(escapeRegex(blockedKeyword), "i").test(value),
  },
  {
    id: "macos-home-path",
    description: "contains a macOS user-local absolute path",
    test: (value) =>
      new RegExp(
        `(?:^|[^\\w/])(?:file:\\/\\/)?${escapeRegex(
          macHomePrefix,
        )}[^/\\s"'\\\`]+(?:/|$)`,
        "i",
      ).test(value),
  },
  {
    id: "linux-home-path",
    description: "contains a Linux user-local absolute path",
    test: (value) =>
      new RegExp(
        `(?:^|[^\\w/])(?:file:\\/\\/)?${escapeRegex(
          linuxHomePrefix,
        )}[^/\\s"'\\\`]+(?:/|$)`,
        "i",
      ).test(value),
  },
  {
    id: "windows-user-path",
    description: "contains a Windows user-local absolute path",
    test: (value) =>
      new RegExp(
        `[A-Za-z]:[\\\\/]+${escapeRegex(
          windowsUsersDir,
        )}[\\\\/]+[^\\\\/\\s"'\\\`]+[\\\\/]`,
      ).test(value),
  },
];

const findings = [
  ...scanStagedPaths(),
  ...scanStagedAddedLines(),
].slice(0, MAX_FINDINGS);

if (findings.length > 0) {
  console.error(
    "Runweave staged safety check blocked this commit. Remove local paths or company-specific text from the staged changes.",
  );
  console.error("");

  for (const finding of findings) {
    const location =
      finding.lineNumber === null
        ? finding.filePath
        : `${finding.filePath}:${finding.lineNumber}`;
    console.error(`- ${sanitize(location)} [${finding.rule.id}]`);
    console.error(`  ${finding.rule.description}`);
    if (finding.preview) {
      console.error(`  ${sanitize(finding.preview)}`);
    }
  }

  const totalFindings = scanStagedPaths().length + scanStagedAddedLines().length;
  if (totalFindings > MAX_FINDINGS) {
    console.error("");
    console.error(
      `Showing first ${MAX_FINDINGS} findings out of ${totalFindings}.`,
    );
  }

  process.exit(1);
}

function scanStagedPaths() {
  const output = runGit([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMRT",
    "-z",
    "--",
  ]);

  return output
    .split("\0")
    .filter(Boolean)
    .flatMap((filePath) =>
      matchingRules(filePath).map((rule) => ({
        filePath,
        lineNumber: null,
        preview: null,
        rule,
      })),
    );
}

function scanStagedAddedLines() {
  const output = runGit([
    "diff",
    "--cached",
    "--unified=0",
    "--no-ext-diff",
    "--text",
    "--diff-filter=ACMRT",
    "--",
  ]);

  const findings = [];
  let filePath = null;
  let lineNumber = null;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      filePath = line.slice("+++ b/".length);
      continue;
    }

    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      lineNumber = Number.parseInt(hunkMatch[1], 10);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      const addedText = line.slice(1);
      for (const rule of matchingRules(addedText)) {
        findings.push({
          filePath: filePath ?? "(unknown file)",
          lineNumber,
          preview: addedText.trim().slice(0, 160),
          rule,
        });
      }
      if (lineNumber !== null) {
        lineNumber += 1;
      }
      continue;
    }

    if (
      lineNumber !== null &&
      line &&
      !line.startsWith("-") &&
      !line.startsWith("\\")
    ) {
      lineNumber += 1;
    }
  }

  return findings;
}

function matchingRules(value) {
  return rules.filter((rule) => rule.test(value));
}

function runGit(args) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: "pipe",
  });

  if (result.status !== 0) {
    const command = ["git", ...args].join(" ");
    throw new Error(
      `${command} failed: ${result.stderr || result.stdout || result.status}`,
    );
  }

  return result.stdout;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitize(value) {
  return value
    .replace(new RegExp(escapeRegex(blockedKeyword), "gi"), "[redacted]")
    .replace(
      new RegExp(`${escapeRegex(macHomePrefix)}[^/\\s"'\\\`]+`, "gi"),
      `${macHomePrefix}[redacted]`,
    )
    .replace(
      new RegExp(`${escapeRegex(linuxHomePrefix)}[^/\\s"'\\\`]+`, "gi"),
      `${linuxHomePrefix}[redacted]`,
    )
    .replace(
      new RegExp(
        `[A-Za-z]:[\\\\/]+${escapeRegex(
          windowsUsersDir,
        )}[\\\\/]+[^\\\\/\\s"'\\\`]+`,
        "g",
      ),
      `C:\\${windowsUsersDir}\\[redacted]`,
    );
}
