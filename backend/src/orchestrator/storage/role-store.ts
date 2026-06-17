import type { OrchestratorRoleDefinition } from "@runweave/shared";
import { DEFAULT_ROLES, isLegacyDefaultRoleSet } from "../default-roles";
import type { OrchestratorPaths } from "./orchestrator-paths";
import { readJsonFile, writeJsonFile } from "./json-file";

export class OrchestratorRoleStore {
  constructor(private readonly paths: OrchestratorPaths) {}

  async listRoles(): Promise<OrchestratorRoleDefinition[]> {
    const value = await readJsonFile<{ roles?: OrchestratorRoleDefinition[] }>(
      this.paths.rolesFilePath(),
    );
    return Array.isArray(value?.roles) ? value.roles : DEFAULT_ROLES;
  }

  async migrateLegacyDefaultRoles(): Promise<void> {
    const value = await readJsonFile<{ roles?: OrchestratorRoleDefinition[] }>(
      this.paths.rolesFilePath(),
    );
    if (Array.isArray(value?.roles) && isLegacyDefaultRoleSet(value.roles)) {
      await writeJsonFile(this.paths.rolesFilePath(), { roles: DEFAULT_ROLES });
    }
  }

  async saveRoles(
    roles: OrchestratorRoleDefinition[],
  ): Promise<OrchestratorRoleDefinition[]> {
    await writeJsonFile(this.paths.rolesFilePath(), { roles });
    return roles;
  }
}
