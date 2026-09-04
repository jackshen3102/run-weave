import type {
  AgentTeamGlobalModelConfig,
  AgentTeamModelProvider,
  AgentTeamProviderCatalog,
  AgentTeamRole,
  AgentTeamRoleModelConfig,
  AgentTeamRoleModelConfigMap,
  AgentTeamRoleRuntime,
  AgentTeamRoleRuntimeSnapshot,
} from "@runweave/shared/agent-team-model-config";
import type {
  AgentTeamRun,
  AgentTeamTerminal,
} from "@runweave/shared/agent-team";
import { AgentTeamError } from "../errors";

export const AGENT_TEAM_ROLES: readonly AgentTeamRole[] = [
  "main",
  "code",
  "code_review",
  "behavior_verify",
];

const DEFAULT_AGENT_TEAM_AGENT_COMMAND = "codex";

export function resolveAgentTeamTerminal(
  terminal: AgentTeamTerminal | undefined,
): AgentTeamTerminal {
  return {
    command: terminal?.command?.trim() || DEFAULT_AGENT_TEAM_AGENT_COMMAND,
    args: [...(terminal?.args ?? [])],
    cwd: terminal?.cwd?.trim() || null,
    runtimePreference: terminal?.runtimePreference ?? "auto",
  };
}

export function resolveAgentTeamRoleTerminal(
  run: Pick<AgentTeamRun, "terminal" | "roleRuntimes">,
  role: AgentTeamRole,
): AgentTeamTerminal {
  return resolveAgentTeamTerminal(
    run.roleRuntimes?.roles[role]?.terminal ?? run.terminal,
  );
}

export function isAgentTeamRoleModelConfigMap(
  value: unknown,
): value is AgentTeamRoleModelConfigMap {
  if (!isRecord(value) || !hasExactKeys(value, AGENT_TEAM_ROLES)) {
    return false;
  }
  return AGENT_TEAM_ROLES.every((role) =>
    isAgentTeamRoleModelConfig(value[role]),
  );
}

export function isAgentTeamGlobalModelConfig(
  value: unknown,
): value is AgentTeamGlobalModelConfig {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    isAgentTeamRoleModelConfigMap(value.roles)
  );
}

export function validateAgentTeamRoleModelConfigMap(
  roles: AgentTeamRoleModelConfigMap,
  catalogs: Record<AgentTeamModelProvider, AgentTeamProviderCatalog>,
): void {
  for (const role of AGENT_TEAM_ROLES) {
    const selection = roles[role];
    const catalog = catalogs[selection.provider];
    if (catalog.availability !== "available") {
      throw new AgentTeamError(
        409,
        `${role} 选择的 ${selection.provider} 当前不可用`,
        {
          code: "provider_unavailable",
          role,
          provider: selection.provider,
        },
      );
    }
    const model = catalog.models.find(
      (candidate) => candidate.id === selection.model,
    );
    if (!model) {
      throw new AgentTeamError(
        409,
        `${role} 选择的 ${selection.provider} 模型 "${selection.model}" 当前不可用`,
        {
          code: "model_unavailable",
          role,
          provider: selection.provider,
          model: selection.model,
        },
      );
    }
    if (
      selection.reasoningEffort !== null &&
      !model.reasoningEfforts.includes(selection.reasoningEffort)
    ) {
      throwUnsupportedParameter(
        role,
        selection,
        `reasoning:${selection.reasoningEffort}`,
      );
    }
    if (
      selection.provider === "codex" &&
      selection.fast &&
      !model.supportsFast
    ) {
      throwUnsupportedParameter(role, selection, "fast");
    }
    if (selection.provider === "traex" && selection.max && !model.supportsMax) {
      throwUnsupportedParameter(role, selection, "max");
    }
  }
}

export function compileAgentTeamRoleTerminal(
  selection: AgentTeamRoleModelConfig,
): AgentTeamTerminal {
  const args = ["-m", selection.model];
  if (selection.reasoningEffort !== null) {
    args.push("-c", `model_reasoning_effort="${selection.reasoningEffort}"`);
  }
  if (selection.provider === "codex") {
    args.push(
      "-c",
      `features.fast_mode=${selection.fast ? "true" : "false"}`,
      "-c",
      `service_tier="${selection.fast ? "fast" : "standard"}"`,
    );
  } else {
    args.push(
      "-c",
      `model_backend_variant="${selection.max ? "max" : "standard"}"`,
    );
  }
  return {
    command: selection.provider,
    args,
    cwd: null,
    runtimePreference: "auto",
  };
}

export function createAgentTeamRoleRuntimeSnapshot(
  config: AgentTeamGlobalModelConfig,
  catalogs: Record<AgentTeamModelProvider, AgentTeamProviderCatalog>,
  capturedAt: string = new Date().toISOString(),
): AgentTeamRoleRuntimeSnapshot {
  validateAgentTeamRoleModelConfigMap(config.roles, catalogs);
  const roles = {} as Record<AgentTeamRole, AgentTeamRoleRuntime>;
  for (const role of AGENT_TEAM_ROLES) {
    const selection = structuredClone(config.roles[role]);
    const catalog = catalogs[selection.provider];
    roles[role] = {
      selection,
      terminal: compileAgentTeamRoleTerminal(selection),
      providerVersion: catalog.version,
      catalogCapturedAt: catalog.capturedAt,
    };
  }
  return {
    schemaVersion: 1,
    source: "global_config",
    capturedAt,
    roles,
  };
}

export function cloneAgentTeamRoleRuntimeSnapshot(
  snapshot: AgentTeamRoleRuntimeSnapshot,
  options?: {
    source?: AgentTeamRoleRuntimeSnapshot["source"];
    capturedAt?: string;
  },
): AgentTeamRoleRuntimeSnapshot {
  return {
    schemaVersion: 1,
    source: options?.source ?? snapshot.source,
    capturedAt: options?.capturedAt ?? snapshot.capturedAt,
    roles: Object.fromEntries(
      AGENT_TEAM_ROLES.map((role) => {
        const runtime = snapshot.roles[role];
        return [
          role,
          {
            selection: structuredClone(runtime.selection),
            terminal: resolveAgentTeamTerminal(runtime.terminal),
            providerVersion: runtime.providerVersion,
            catalogCapturedAt: runtime.catalogCapturedAt,
          },
        ];
      }),
    ) as Record<AgentTeamRole, AgentTeamRoleRuntime>,
  };
}

export function createLegacyAgentTeamRoleRuntimeSnapshot(
  terminal: AgentTeamTerminal,
  options?: {
    source?: AgentTeamRoleRuntimeSnapshot["source"];
    capturedAt?: string;
  },
): AgentTeamRoleRuntimeSnapshot {
  const normalizedTerminal = resolveAgentTeamTerminal(terminal);
  const selection = inferLegacySelection(normalizedTerminal);
  const runtime: AgentTeamRoleRuntime = {
    selection,
    terminal: normalizedTerminal,
    providerVersion: null,
    catalogCapturedAt: null,
  };
  return {
    schemaVersion: 1,
    source: options?.source ?? "legacy_terminal",
    capturedAt: options?.capturedAt ?? new Date().toISOString(),
    roles: Object.fromEntries(
      AGENT_TEAM_ROLES.map((role) => [
        role,
        {
          ...runtime,
          selection: structuredClone(runtime.selection),
          terminal: resolveAgentTeamTerminal(runtime.terminal),
        },
      ]),
    ) as Record<AgentTeamRole, AgentTeamRoleRuntime>,
  };
}

function inferLegacySelection(
  terminal: AgentTeamTerminal,
): AgentTeamRoleModelConfig {
  const command = (terminal.command ?? "")
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.exe$/i, "")
    .toLowerCase();
  const provider: AgentTeamModelProvider =
    command === "traex" ? "traex" : "codex";
  const args = terminal.args ?? [];
  const modelFlagIndex = args.findIndex(
    (arg) => arg === "-m" || arg === "--model",
  );
  const model = modelFlagIndex >= 0 ? (args[modelFlagIndex + 1] ?? "") : "";
  const reasoningEntry = args.find((arg) =>
    arg.startsWith("model_reasoning_effort="),
  );
  const reasoningEffort = reasoningEntry
    ? stripConfigString(reasoningEntry.slice("model_reasoning_effort=".length))
    : null;
  if (provider === "traex") {
    return {
      provider,
      model,
      reasoningEffort,
      max: args.includes('model_backend_variant="max"'),
    };
  }
  return {
    provider,
    model,
    reasoningEffort,
    fast:
      args.includes("features.fast_mode=true") ||
      args.includes('service_tier="fast"'),
  };
}

function isAgentTeamRoleModelConfig(
  value: unknown,
): value is AgentTeamRoleModelConfig {
  if (
    !isRecord(value) ||
    typeof value.model !== "string" ||
    (value.reasoningEffort !== null &&
      typeof value.reasoningEffort !== "string")
  ) {
    return false;
  }
  if (value.provider === "codex") {
    return (
      hasExactKeys(value, ["provider", "model", "reasoningEffort", "fast"]) &&
      typeof value.fast === "boolean"
    );
  }
  return (
    value.provider === "traex" &&
    hasExactKeys(value, ["provider", "model", "reasoningEffort", "max"]) &&
    typeof value.max === "boolean"
  );
}

function throwUnsupportedParameter(
  role: AgentTeamRole,
  selection: AgentTeamRoleModelConfig,
  parameter: string,
): never {
  throw new AgentTeamError(
    409,
    `${role} 选择的 ${selection.provider} 模型 "${selection.model}" 不支持参数 ${parameter}`,
    {
      code: "parameter_unsupported",
      role,
      provider: selection.provider,
      model: selection.model,
      parameter,
    },
  );
}

function stripConfigString(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
