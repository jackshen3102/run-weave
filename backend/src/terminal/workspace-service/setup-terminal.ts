import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CreateWorktreeContextRequest } from "@runweave/shared/terminal/project-context";
import { terminalShellName } from "@runweave/shared/terminal/shell";
import { prepareTerminalAgent } from "../application/agent-preparation";
import { sendInputToSession } from "../application/input-dispatcher";
import {
  buildPaneTarget,
  type TerminalPanelOptions,
} from "../application/panel-common";
import type {
  TerminalSessionManager,
  TerminalSessionRecord,
} from "../manager/manager";
import { isTmuxBackedSession } from "../runtime/launcher";
import { logger } from "../../logging/index";

interface Setup {
  command: string;
  cwdPath: string;
}

async function invokeScript(shell: string, script: string) {
  if (process.platform === "win32") {
    const launcher = path.join(path.dirname(script), "setup.cmd");
    const binary = process.execPath.replaceAll("%", "%%");
    await writeFile(
      launcher,
      [
        "@echo off",
        "setlocal DisableDelayedExpansion",
        'set "ELECTRON_RUN_AS_NODE=1"',
        '"' + binary + '" "%~dp0setup.cjs"',
        "exit /b %errorlevel%",
      ].join("\r\n"),
      { flag: "wx", mode: 0o600 },
    );
    const name = terminalShellName(shell);
    if (name === "powershell" || name === "pwsh")
      return "& '" + launcher.replaceAll("'", "''") + "'";
    if (/[%!"\r\n]/u.test(launcher)) throw new Error("Unsafe cmd script path");
    return '"' + launcher + '"';
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  return (
    "env ELECTRON_RUN_AS_NODE=1 " +
    [process.execPath, script].map(quote).join(" ")
  );
}

/** Stage approved text outside the repository. Echoed interactive input contains no completion token. */
async function stageSetup(setup: Setup, token: string, file: string) {
  const body = [
    "const { spawnSync } = require('node:child_process');",
    "const { realpathSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');",
    "const path = require('node:path');",
    "unlinkSync(__filename);",
    "const command = " + JSON.stringify(setup.command) + ";",
    "const cwd = " + JSON.stringify(setup.cwdPath) + ";",
    "if (realpathSync(cwd) !== cwd) throw Error('Worktree setup directory changed');",
    "console.log('[Runweave Setup] Running: ' + command);",
    "delete process.env.ELECTRON_RUN_AS_NODE;",
    "const result = spawnSync(command, { shell: true, stdio: 'inherit', cwd });",
    "if (result.error) console.error(result.error.message);",
    "const code = result.status ?? 1;",
    "const receipt = '" + token + ":' + code;",
    "console.log('\\n' + receipt);",
    "const output = path.join(__dirname, 'exit');",
    // Terminal line wrapping and scrollback retention cannot change the private exit receipt.
    "try {",
    "  writeFileSync(output + '.tmp', receipt, {flag: 'wx', mode: 0o600});",
    "  renameSync(output + '.tmp', output);",
    "} catch (error) { if (error.code !== 'ENOENT') throw error; }",
    "process.exitCode = code;",
  ];
  await writeFile(file, body.join("\n"), { mode: 0o600, flag: "wx" });
}

export async function startWorktreeTerminal(
  manager: TerminalSessionManager,
  session: TerminalSessionRecord,
  options: TerminalPanelOptions,
  setup: Setup | undefined,
  agent: CreateWorktreeContextRequest["launchAgent"],
  inputChanged: () => boolean,
) {
  if (!setup && (!agent || agent === "none")) return;
  const panelId = manager.getPanelWorkspace(session.id)?.activePanelId;
  const panel = panelId ? manager.getPanel(panelId) : undefined;
  const tmux = isTmuxBackedSession(session) ? options.tmuxService : undefined;
  if (isTmuxBackedSession(session) && (!panel || !tmux))
    throw new Error("Initial terminal pane unavailable");
  const target =
    panel && tmux ? buildPaneTarget(session, tmux, panel) : undefined;
  const runtime = options.runtimeRegistry?.getSessionRuntime(session.id);
  const validate = () => {
    if (
      manager.getSession(session.id) !== session ||
      session.status !== "running" ||
      inputChanged() ||
      (panel &&
        (manager.getPanel(panel.id)?.status !== "running" ||
          manager.getPanel(panel.id)?.tmuxPaneId !== target?.paneId)) ||
      (!tmux &&
        (!runtime ||
          options.runtimeRegistry?.getSessionRuntime(session.id) !== runtime))
    ) {
      throw new Error("Initial terminal was closed, replaced or taken over");
    }
  };
  const send = (command: string) =>
    sendInputToSession(
      manager,
      { ...options, supervisorInput: true, validateSupervisorTarget: validate },
      session,
      command,
      "line",
      undefined,
      target,
    );
  const launch = async () => {
    if (!agent || agent === "none") return;
    validate();
    if (panel && tmux && agent !== "claude") {
      await prepareTerminalAgent(
        manager,
        session,
        options,
        { agent, panelId: panel.id, prompt: "" },
        {
          reuseReadyShell: true,
          supervisorInput: true,
          validateLaunchTarget: validate,
          validateSupervisorTarget: validate,
        },
      );
    } else {
      await send(agent);
    }
  };

  if (!setup) {
    await launch();
    return;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "rw-worktree-setup-"));
  const file = path.join(directory, "setup.cjs");
  const token = "__RUNWEAVE_SETUP_DONE_" + randomBytes(16).toString("hex");
  const receiptPath = path.join(directory, "exit");
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    await stageSetup(setup, token, file);
    await send(await invokeScript(session.command, file));
  } catch (error) {
    await cleanup();
    throw error;
  }

  const observe = async () => {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await delay(400, undefined, { ref: false });
      validate();
      const receipt = await readFile(receiptPath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (receipt !== null) {
        if (receipt === token + ":0") await launch();
        return;
      }
    }
  };
  void observe()
    .finally(cleanup)
    .catch((error) =>
      logger.warn("terminal.worktree.setup-ended", {
        terminalSessionId: session.id,
        error,
      }),
    );
}
