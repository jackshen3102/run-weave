import path from "node:path";
import { resolveBetaAppName } from "./runweave-update-core.mjs";

export const updateTarget =
  process.env.RUNWEAVE_UPDATE_TARGET === "beta" ? "beta" : "stable";
export const isBetaTarget = updateTarget === "beta";
export const isBetaTerminal =
  !isBetaTarget && process.env.RUNWEAVE_DESKTOP_CHANNEL === "beta";
export const appName = isBetaTarget
  ? (process.env.RUNWEAVE_LOCAL_UPDATE_APP_NAME ??
    resolveBetaAppName(
      process.env.RUNWEAVE_DESKTOP_INSTANCE_ID ?? "default",
    ))
  : "Runweave";
export const channel = updateTarget;
export const electronBuilderConfig =
  (isBetaTarget ? process.env.RUNWEAVE_ELECTRON_BUILDER_CONFIG : null) ??
  (isBetaTarget
    ? "electron-builder.beta.yml"
    : "electron-builder.local-updates.yml");
export const codesignEnvFileRelativePath = path.join("backend", ".env");

if (isBetaTerminal) {
  for (const name of [
    "BROWSER_PROFILE_DIR",
    "RUNWEAVE_ACCESS_TOKEN",
    "RUNWEAVE_APP_BACKUP_PATH",
    "RUNWEAVE_APP_SERVER_CLOUD_SYNC_DIR",
    "RUNWEAVE_APP_SERVER_HOME",
    "RUNWEAVE_APP_SERVER_RUNTIME_ROOT",
    "RUNWEAVE_APP_SERVER_STATE_DIR",
    "RUNWEAVE_APP_SERVER_URL",
    "RUNWEAVE_APP_SERVER_TOKEN",
    "RUNWEAVE_BACKEND_PORT",
    "RUNWEAVE_BASE_URL",
    "RUNWEAVE_CONFIG_FILE",
    "RUNWEAVE_DESKTOP_CHANNEL",
    "RUNWEAVE_ELECTRON_BUILDER_CONFIG",
    "RUNWEAVE_LOCAL_UPDATE_APP_NAME",
    "RUNWEAVE_RUNTIME_HOME",
    "RUNWEAVE_UPDATE_STATE_PATH",
  ]) {
    delete process.env[name];
  }
}
