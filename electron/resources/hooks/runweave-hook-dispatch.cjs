#!/usr/bin/env node
/* global __dirname, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn } = require("node:child_process");
const path = require("node:path");

const SOURCES = new Set(["codex", "trae", "traecli", "traex", "claude"]);

function normalizeSource(value) {
  const source = String(value || "")
    .trim()
    .toLowerCase();
  return SOURCES.has(source) ? source : null;
}

function inferPluginRootSource(value) {
  if (!value) {
    return null;
  }
  const parts = path.resolve(value).split(path.sep).filter(Boolean);
  if (hasAdjacentPathParts(parts, ".codex", "plugins")) {
    return "codex";
  }
  if (hasPathSequence(parts, [".trae", "plugins"])) {
    return "trae";
  }
  if (hasAdjacentPathParts(parts, ".claude", "plugins")) {
    return "claude";
  }
  return null;
}

function hasAdjacentPathParts(parts, first, second) {
  return parts.some(
    (part, index) => part === first && parts[index + 1] === second,
  );
}

function hasPathSequence(parts, sequence) {
  let sequenceIndex = 0;
  for (const part of parts) {
    if (part !== sequence[sequenceIndex]) {
      continue;
    }
    sequenceIndex += 1;
    if (sequenceIndex === sequence.length) {
      return true;
    }
  }
  return false;
}

function inferSource() {
  const sourceIndex = process.argv.indexOf("--source");
  const argumentSource =
    sourceIndex >= 0 ? normalizeSource(process.argv[sourceIndex + 1]) : null;
  if (argumentSource) return argumentSource;
  const explicit = normalizeSource(process.env.RUNWEAVE_HOOK_SOURCE);
  if (explicit) {
    return explicit;
  }

  const pluginRootSource = inferPluginRootSource(path.resolve(__dirname, ".."));
  if (pluginRootSource) {
    return pluginRootSource;
  }
  const inferredSources = new Set();
  if (process.env.CODEX_PLUGIN_ROOT) {
    inferredSources.add(
      inferPluginRootSource(process.env.CODEX_PLUGIN_ROOT) || "codex",
    );
  }
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    inferredSources.add(
      inferPluginRootSource(process.env.CLAUDE_PLUGIN_ROOT) || "claude",
    );
  }
  return inferredSources.size === 1 ? [...inferredSources][0] : "unknown";
}

function main() {
  const bridgePath = path.join(__dirname, "runweave-hook-bridge.cjs");
  const source = inferSource();
  const child = spawn(
    process.execPath,
    [bridgePath, "--source", source, ...process.argv.slice(2)],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );

  process.stdin.pipe(child.stdin);
  // Only Codex Stop may return a native continuation. Validate before passing
  // stdout through so diagnostics can never become hook instructions.
  let output = "";
  child.stdout.on("data", (chunk) => {
    if (output.length < 16000) output += chunk;
  });
  child.on("error", () => {
    process.exitCode = 0;
  });
  child.on("close", () => {
    if (source === "codex") {
      try {
        const result = JSON.parse(output);
        if (
          result.decision === "block" &&
          typeof result.reason === "string" &&
          result.reason.startsWith("[runweave-task-supervision:")
        )
          process.stdout.write(
            JSON.stringify({ decision: "block", reason: result.reason }),
          );
      } catch {
        /* Empty output is the normal allow-stop path. */
      }
    }
    process.exitCode = 0;
  });
}

main();
