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
  const pluginRoot = path.resolve(value);
  if (pluginRoot.includes(`${path.sep}.codex${path.sep}`)) {
    return "codex";
  }
  if (pluginRoot.includes(`${path.sep}.trae${path.sep}`)) {
    return "trae";
  }
  if (pluginRoot.includes(`${path.sep}.claude${path.sep}`)) {
    return "claude";
  }
  return null;
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
