import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveBetaPaths } from "../beta/state.mjs";
import { configurationLibrary as configuration } from "../lib/configuration.mjs";
import { DevSessionError } from "./contracts.mjs";

const execFileAsync = promisify(execFile);

export async function prepareBetaProject(manifest, requestedPath) {
  if (manifest.profile !== "beta" || manifest.services.backend?.ownership !== "dedicated") {
    throw new DevSessionError("ready project requires an owned Beta Backend", 4);
  }
  const projectPath = await fs.realpath(path.resolve(requestedPath));
  const paths = resolveBetaPaths(
    manifest.source.root,
    os.homedir(),
    manifest.targetEnvironment.instanceId,
    manifest.devSessionId,
  );
  const context = configuration.resolveConfigurationContext({ args: ["--instance", manifest.devSessionId] });
  const config = new configuration.ConfigurationStore(context).read().value.cli;
  const profile = config?.profiles?.[config.activeProfile];
  if (
    profile?.baseUrl !== manifest.services.backend.url ||
    typeof profile.accessToken !== "string" ||
    !profile.accessToken
  ) {
    throw new DevSessionError("Beta CLI profile does not match the owned Backend", 4);
  }
  const env = { ...process.env };
  for (const name of ["RUNWEAVE_BASE_URL", "RUNWEAVE_BACKEND_PORT", "RUNWEAVE_ACCESS_TOKEN", "RUNWEAVE_CONFIG_FILE"]) {
    delete env[name];
  }
  const runCli = async (...args) => {
    const { stdout } = await execFileAsync(process.execPath, [paths.controlCliPath, ...configuration.configurationArguments(context), ...args, "--json"], {
      cwd: manifest.source.root,
      env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15_000,
    });
    return JSON.parse(stdout);
  };
  const project = await runCli("project", "ensure", "--name", path.basename(projectPath), "--path", projectPath);
  if (!project.projectId || project.path !== projectPath) {
    throw new DevSessionError("Beta project identity did not match the requested path", 4);
  }
  const terminal = await runCli("terminal", "create", "--project-id", project.projectId, "--cwd", projectPath);
  if (!terminal.terminalSessionId) {
    throw new DevSessionError("Beta terminal creation returned no terminal id", 4);
  }
  await runCli("terminal", "send", terminal.terminalSessionId, "--text", "pwd", "--enter");
  const deadline = Date.now() + 10_000;
  let shellReady = false;
  while (Date.now() < deadline) {
    const snapshot = await runCli("terminal", "snapshot", terminal.terminalSessionId, "--tail", "30");
    const lines = (snapshot.tail ?? "").replaceAll("\r", "").split("\n").map((line) => line.trim());
    if (lines.includes(projectPath)) {
      shellReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (!shellReady) {
    throw new DevSessionError("Beta terminal did not execute the shell probe", 4);
  }
  return {
    projectId: project.projectId,
    projectPath,
    terminalSessionId: terminal.terminalSessionId,
    shellReady,
  };
}
