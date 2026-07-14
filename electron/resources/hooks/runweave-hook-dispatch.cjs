#!/usr/bin/env node
/* global __dirname, process, require */
/* eslint-disable @typescript-eslint/no-require-imports */

const { spawn } = require("node:child_process");
const path = require("node:path");

const SOURCES = new Set(["codex", "trae", "claude"]);

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
  const explicit = normalizeSource(process.env.RUNWEAVE_HOOK_SOURCE);
  if (explicit) {
    return explicit;
  }

  const pluginRootSource = inferPluginRootSource(
    path.resolve(__dirname, ".."),
  );
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
      stdio: ["pipe", "ignore", "ignore"],
    },
  );

  process.stdin.pipe(child.stdin);
  child.on("error", () => {
    process.exitCode = 0;
  });
  child.on("close", () => {
    process.exitCode = 0;
  });
}

main();
