import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { configuration, ConfigurationError } from "@runweave/config-node";
import { readConfigurationPath } from "@runweave/shared/configuration";

/** Detect known sources only; never silently replace an existing identity. */
export function requireDesktopMigration(key: string, legacyRelativePath: string): void {
  const snapshot = configuration().store.read();
  if (readConfigurationPath(snapshot.value, key) != null) return;
  if (existsSync(path.join(app.getPath("userData"), legacyRelativePath))) throw new ConfigurationError("CONFIG_MIGRATION_REQUIRED", [key]);
}
