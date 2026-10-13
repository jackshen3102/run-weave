import type {
  AgentTeamCatalogModel,
  AgentTeamModelProvider,
  AgentTeamProviderCatalog,
  AgentTeamRole,
  AgentTeamRoleModelConfig,
  AgentTeamRoleModelConfigMap,
} from "@runweave/shared/agent-team-model-config";
const ROLES: readonly AgentTeamRole[] = [
  "main",
  "code",
  "code_review",
  "behavior_verify",
];
export function createEmptyRoleMap(
  catalogs: Record<AgentTeamModelProvider, AgentTeamProviderCatalog>,
): AgentTeamRoleModelConfigMap {
  const provider: AgentTeamModelProvider =
    catalogs.codex.availability === "available"
      ? "codex"
      : catalogs.traex.availability === "available"
        ? "traex"
        : "codex";
  return Object.fromEntries(
    ROLES.map((role) => [role, createEmptyRole(provider)]),
  ) as AgentTeamRoleModelConfigMap;
}

export function createEmptyRole(
  provider: AgentTeamModelProvider,
): AgentTeamRoleModelConfig {
  return provider === "codex"
    ? {
        provider,
        model: "",
        reasoningEffort: null,
        fast: false,
      }
    : {
        provider,
        model: "",
        reasoningEffort: null,
        max: false,
      };
}

export function isValidRole(
  role: AgentTeamRoleModelConfig,
  catalog: AgentTeamProviderCatalog,
): boolean {
  if (catalog.availability !== "available") return false;
  const model = catalog.models.find((candidate) => candidate.id === role.model);
  if (!model) return false;
  if (
    role.reasoningEffort !== null &&
    !model.reasoningEfforts.includes(role.reasoningEffort)
  ) {
    return false;
  }
  return role.provider === "codex"
    ? !role.fast || model.supportsFast
    : !role.max || model.supportsMax;
}

export function formatRoleSummary(
  role: AgentTeamRoleModelConfig,
  catalog: AgentTeamProviderCatalog,
  model: AgentTeamCatalogModel | undefined,
): string {
  const provider = role.provider === "codex" ? "Codex" : "TraeX";
  if (catalog.availability !== "available") return `${provider} · 当前不可用`;
  if (!model) return `${provider} · 请选择模型`;
  return [provider, model.label, role.reasoningEffort]
    .filter(Boolean)
    .join(" · ");
}
