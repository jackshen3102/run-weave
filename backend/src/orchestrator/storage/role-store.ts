import type { OrchestratorRoleDefinition } from "@runweave/shared";
import { DEFAULT_ROLES, isLegacyDefaultRoleSet } from "../default-roles";
import type { OrchestratorPaths } from "./orchestrator-paths";
import { readJsonFile, writeJsonFile } from "./json-file";

export class OrchestratorRoleStore {
  constructor(private readonly paths: OrchestratorPaths) {}

  async listRoles(): Promise<OrchestratorRoleDefinition[]> {
    const roles = await this.readStoredRoles();
    return roles ?? DEFAULT_ROLES;
  }

  async ensureInitializedRoles(): Promise<void> {
    const roles = await this.readStoredRoles();
    if (!roles || roles.length === 0 || isLegacyDefaultRoleSet(roles)) {
      await writeJsonFile(this.paths.rolesFilePath(), { roles: DEFAULT_ROLES });
    }
  }

  async saveRoles(
    roles: OrchestratorRoleDefinition[],
  ): Promise<OrchestratorRoleDefinition[]> {
    await writeJsonFile(this.paths.rolesFilePath(), { roles });
    return roles;
  }

  private async readStoredRoles(): Promise<OrchestratorRoleDefinition[] | null> {
    const value = await readJsonFile<
      OrchestratorRoleDefinition[] | { roles?: OrchestratorRoleDefinition[] }
    >(this.paths.rolesFilePath());
    if (Array.isArray(value)) {
      return value;
    }
    return Array.isArray(value?.roles) ? value.roles : null;
  }
}
