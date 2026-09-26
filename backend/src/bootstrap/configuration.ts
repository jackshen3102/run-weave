import { installBoundCli } from "./bound-cli";
import { initializeConfiguration, acquireConfigurationOwner, ConfigurationError, BACKEND_CORE_CONFIGURATION_DOMAINS } from "@runweave/config-node";
import { loadAuthConfig } from "../auth/config";
import { initializeLogger, logger } from "../logging/index";
import type { ResourceScope } from "./resource-scope";

export function initializeBackendConfiguration(resources: ResourceScope) {
  const config = initializeConfiguration();
  for (const domain of BACKEND_CORE_CONFIGURATION_DOMAINS) config.requireDomain(domain);
  if (config.context.kind === "stable") {
    const missing = ["browserProfileDirectory", "activityDirectory", "evolutionDirectory", "experienceDirectory", "scheduledTasksDirectory"].filter((key) => !config.get(`storage.${key}`));
    if (missing.length) throw new ConfigurationError("CONFIG_STORAGE_SELECTION_REQUIRED", missing.map((key) => `storage.${key}`));
  }
  // Validate identity before creating a log directory, owner record or database.
  loadAuthConfig();
  const owner = acquireConfigurationOwner(config.context, "backend");
  resources.defer("configuration-owner", () => owner.release());
  installBoundCli(config.context);
  const loggerState = initializeLogger();
  logger.debug("backend.logger.initialized", {
    component: "backend", logDir: loggerState.logDir, logToFile: loggerState.logToFile,
  });
  return config;
}
