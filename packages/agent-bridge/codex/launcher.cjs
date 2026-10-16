#!/usr/bin/env node
/* global __dirname, process, require, console */
/* eslint-disable @typescript-eslint/no-require-imports */
// An explicitly selected Runweave executable, never an installation over the user's CLI.
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const env = { ...process.env };
const args = process.argv.slice(2);
const root = env.RUNWEAVE_RUNTIME_CONFIG_ROOT;
const terminalId = env.RUNWEAVE_TERMINAL_SESSION_ID;
let panelId = env.RUNWEAVE_TERMINAL_PANEL_ID;
let operationId = env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID;
// Child CLIs and noninteractive tools must not overwrite the owning TUI's observation.
const interactive = !args.some((arg) => ["exec", "review", "app-server", "--version", "-V", "--help", "-h"].includes(arg));
if (root && terminalId && interactive && !env.RUNWEAVE_CODEX_CONTEXT_GENERATION) {
  // Automatic tmux recovery starts the shell before the workspace is reconciled.
  // Resolve its actual pane binding, never infer a panel from the last thread.
  if (!panelId && env.TMUX && env.TMUX_PANE) {
    const deadline = Date.now() + 5000;
    do {
      const result = spawnSync(env.RUNWEAVE_RUNTIME_TMUX_BINARY || "tmux", [
        "-S", env.TMUX.split(",")[0], "show-options", "-p", "-v", "-t", env.TMUX_PANE, "@runweave_panel_id",
      ], { encoding: "utf8", timeout: 1000 });
      const value = result.status === 0 ? result.stdout.trim() : "";
      if (/^[0-9a-f-]{36}$/i.test(value)) { panelId = value; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    } while (Date.now() < deadline);
  }
  if (!panelId) {
    console.error("Runweave Codex could not resolve this terminal panel; restart the terminal after its workspace is ready.");
    process.exit(1);
  }
  operationId ||= `codex_launch_${randomUUID()}`;
  env.RUNWEAVE_TERMINAL_PANEL_ID = panelId;
  env.RUNWEAVE_TERMINAL_AGENT_OPERATION_ID = operationId;
}
if (root && terminalId && panelId && operationId && interactive && !env.RUNWEAVE_CODEX_CONTEXT_GENERATION) {
  const directory = path.join(root, "codex-context");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const key = createHash("sha256").update(`${terminalId}\0${panelId}`).digest("hex");
  env.RUNWEAVE_CODEX_CONTEXT_PATH = path.join(directory, `${key}.json`);
  env.RUNWEAVE_CODEX_CONTEXT_GENERATION = randomUUID();
  const initial = { protocolVersion: 1, generation: env.RUNWEAVE_CODEX_CONTEXT_GENERATION, operationId, pid: process.pid, revision: 0, primaryThreadId: null, displayedThreadId: null, sides: [], inputReady: false, displayedRunning: false, closed: false };
  const temporary = `${env.RUNWEAVE_CODEX_CONTEXT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(initial), { mode: 0o600 });
  fs.renameSync(temporary, env.RUNWEAVE_CODEX_CONTEXT_PATH);
} else {
  delete env.RUNWEAVE_CODEX_CONTEXT_PATH;
  delete env.RUNWEAVE_CODEX_CONTEXT_GENERATION;
}
if (env.RUNWEAVE_CODEX_CONTEXT_PATH && fs.existsSync(path.join(__dirname, "../hooks/runweave-hook-dispatch.cjs"))) {
  env.RUNWEAVE_TOOLKIT_PLUGIN_ROOT = path.resolve(__dirname, "..");
  env.RUNWEAVE_HOOK_SOURCE = "codex";
}
const nativeArgs = env.RUNWEAVE_CODEX_CONTEXT_PATH ? ["--no-daemon", ...args] : args;
const child = spawn(path.join(__dirname, "native", "codex"), nativeArgs, { env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (env.RUNWEAVE_CODEX_CONTEXT_PATH) {
    try {
      const current = JSON.parse(fs.readFileSync(env.RUNWEAVE_CODEX_CONTEXT_PATH, "utf8"));
      if (current.generation === env.RUNWEAVE_CODEX_CONTEXT_GENERATION) {
        const temporary = `${env.RUNWEAVE_CODEX_CONTEXT_PATH}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify({ ...current, revision: current.revision + 1, closed: true, inputReady: false, displayedThreadId: null }), { mode: 0o600 });
        fs.renameSync(temporary, env.RUNWEAVE_CODEX_CONTEXT_PATH);
      }
    } catch { /* A missing observation remains unavailable to the host. */ }
  }
  process.exitCode = code ?? (signal ? 1 : 0);
});
