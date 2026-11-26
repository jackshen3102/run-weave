import os from "node:os";
import path from "node:path";
import { configuration, settingText } from "./runtime";
import { ConfigurationError } from "./errors";

/** Native tool-owned references, never Runweave storage or a copy of credentials. */
export function resolveAgyConfiguration(env: NodeJS.ProcessEnv = process.env): {
  binary: string;
  configDirectory: string;
  brainDirectory: string;
  globalCustomizationsDirectory: string;
} {
  configuration().requireDomain("agents.agy");
  const binary =
    settingText("agents.agy.binary")
    ?? (env.RUNWEAVE_AGY_BIN?.trim() || undefined)
    ?? (env.AGY_BIN?.trim() || undefined)
    ?? "agy";
  const configDirectory =
    settingText("agents.agy.configDirectory")
    ?? (env.RUNWEAVE_AGY_CONFIG_DIR?.trim() || undefined)
    ?? (env.AGY_CONFIG_DIR?.trim() || undefined)
    ?? path.join(os.userInfo().homedir, ".gemini", "antigravity-cli");
  if (!path.isAbsolute(configDirectory) || [...configDirectory].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new ConfigurationError("CONFIG_FIELD_VALUE_INVALID", ["agents.agy.configDirectory"]);
  }
  return {
    binary,
    configDirectory,
    brainDirectory: path.join(configDirectory, "brain"),
    globalCustomizationsDirectory: path.join(path.dirname(configDirectory), "config"),
  };
}
