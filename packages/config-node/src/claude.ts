import os from "node:os";
import path from "node:path";
import { configuration, settingText } from "./runtime";
import { ConfigurationError } from "./errors";

/** Native tool-owned references, never Runweave storage or a copy of credentials. */
export function resolveClaudeConfiguration(env: NodeJS.ProcessEnv = process.env): {
  binary: string;
  configDirectory: string;
  projectsDirectory: string;
} {
  configuration().requireDomain("agents.claude");
  const binary = settingText("agents.claude.binary") ?? "claude";
  const configDirectory = settingText("agents.claude.configDirectory")
    ?? (env.CLAUDE_CONFIG_DIR || undefined)
    ?? path.join(os.userInfo().homedir, ".claude");
  // External native directories may be outside the instance, but never relative
  // to the service's cwd. Do not create or read native settings here.
  if (!path.isAbsolute(configDirectory) || [...configDirectory].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new ConfigurationError("CONFIG_FIELD_VALUE_INVALID", ["agents.claude.configDirectory"]);
  }
  return { binary, configDirectory, projectsDirectory: path.join(configDirectory, "projects") };
}
