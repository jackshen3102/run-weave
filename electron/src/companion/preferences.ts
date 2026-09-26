import { configuration, ConfigurationDomain } from "@runweave/config-node";
import { requireDesktopMigration } from "../desktop/configuration-migration.js";
const preferences = new ConfigurationDomain<boolean>("desktop.preferences.companion.enabled");
export async function readCompanionEnabled(): Promise<boolean> {
  requireDesktopMigration("desktop.preferences.companion.enabled", "desktop-companion.json");
  return preferences.read() ?? configuration().context.kind === "stable";
}
export function writeCompanionEnabled(enabled: boolean): void {
  preferences.write(enabled);
}
export function markCompanionPreferenceApplied(): void { preferences.markApplied(); }
