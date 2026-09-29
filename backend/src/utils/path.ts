import path from "node:path";
import { configurationPath, settingText } from "@runweave/config-node";
export { expandHomePath } from "@runweave/shared/browser-profile-node";

export interface StoragePaths {
  browserProfileDir: string;
  authStoreFile: string;
  terminalSessionStoreFile: string;
  terminalQuickInputStoreFile: string;
  agentTeamModelStoreFile: string;
  backendLogDir: string;
}
export interface ActivityStoragePaths { activityHomeDir: string; activityDatabaseFile: string }
export interface EvolutionStoragePaths { evolutionHomeDir: string; learningDatabaseFile: string; temporaryDir: string }
export interface ScheduledTaskStoragePaths { scheduledTasksHomeDir: string; scheduledTasksDatabaseFile: string }

export function resolveScheduledTaskStoragePaths(): ScheduledTaskStoragePaths {
  const scheduledTasksHomeDir = configurationPath("storage.scheduledTasksDirectory", "scheduled-tasks");
  return { scheduledTasksHomeDir, scheduledTasksDatabaseFile: path.join(scheduledTasksHomeDir, "scheduled-tasks.sqlite") };
}
export function resolveEvolutionStoragePaths(): EvolutionStoragePaths {
  const evolutionHomeDir = configurationPath("storage.evolutionDirectory", "evolution");
  return { evolutionHomeDir, learningDatabaseFile: path.join(evolutionHomeDir, "learning.sqlite"), temporaryDir: path.join(evolutionHomeDir, "tmp") };
}
export function resolveActivityStoragePaths(): ActivityStoragePaths {
  const activityHomeDir = configurationPath("storage.activityDirectory", "activity");
  return { activityHomeDir, activityDatabaseFile: path.join(activityHomeDir, "activity.sqlite") };
}
export function resolveStoragePaths(): StoragePaths {
  const browserProfileDir = configurationPath("storage.browserProfileDirectory", "backend");
  const authStoreFile = settingText("storage.authStoreFile") ?? path.join(browserProfileDir, "auth-store.json");
  const terminalSessionStoreFile = settingText("storage.terminalSessionStoreFile") ?? path.join(browserProfileDir, "terminal-session-store.json");
  return {
    browserProfileDir, authStoreFile, terminalSessionStoreFile,
    terminalQuickInputStoreFile: settingText("storage.terminalQuickInputStoreFile") ?? path.join(path.dirname(terminalSessionStoreFile), "terminal-quick-inputs.json"),
    agentTeamModelStoreFile: path.join(browserProfileDir, "agent-provider-catalogs.json"),
    backendLogDir: settingText("logging.backendDirectory") ?? path.join(browserProfileDir, "logs", "backend"),
  };
}
