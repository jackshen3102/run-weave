import type {
  AgentTeamCatalogModel,
  AgentTeamModelProvider,
  AgentTeamModelSettingsResponse,
  AgentTeamProviderCatalog,
  AgentTeamRole,
  AgentTeamRoleModelConfig,
  AgentTeamRoleModelConfigMap,
} from "@runweave/shared/agent-team-model-config";
import { useMemoizedFn } from "ahooks";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getAgentTeamModelSettings,
  saveAgentTeamModelSettings,
} from "../../services/terminal";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

const ROLES: readonly AgentTeamRole[] = [
  "main",
  "code",
  "code_review",
  "behavior_verify",
];

const ROLE_META: Record<
  AgentTeamRole,
  { label: string; shortLabel: string; intent: string }
> = {
  main: {
    label: "主 Agent",
    shortLabel: "M",
    intent: "拆解任务并驱动 Agent Team",
  },
  code: {
    label: "实现",
    shortLabel: "C",
    intent: "完成核心代码改动",
  },
  code_review: {
    label: "代码评审",
    shortLabel: "R",
    intent: "审查改动、风险与回归范围",
  },
  behavior_verify: {
    label: "行为验收",
    shortLabel: "V",
    intent: "按测试案例执行真实行为验收",
  },
};

interface TerminalAgentTeamModelConfigDialogProps {
  apiBase: string;
  token: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TerminalAgentTeamModelConfigDialog({
  apiBase,
  token,
  open,
  onOpenChange,
}: TerminalAgentTeamModelConfigDialogProps) {
  const [settings, setSettings] =
    useState<AgentTeamModelSettingsResponse | null>(null);
  const [draftRoles, setDraftRoles] =
    useState<AgentTeamRoleModelConfigMap | null>(null);
  const [selectedRole, setSelectedRole] = useState<AgentTeamRole>("main");
  const [modelSearch, setModelSearch] = useState("");
  const [advancedOpenByRole, setAdvancedOpenByRole] = useState<
    Record<AgentTeamRole, boolean>
  >({
    main: false,
    code: false,
    code_review: false,
    behavior_verify: false,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setSettings(null);
      setDraftRoles(null);
      setModelSearch("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getAgentTeamModelSettings(apiBase, token)
      .then((response) => {
        if (cancelled) return;
        setSettings(response);
        setDraftRoles(
          response.config
            ? structuredClone(response.config.roles)
            : createEmptyRoleMap(response.catalogs),
        );
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, open, token]);

  const role = draftRoles?.[selectedRole] ?? null;
  const catalog = role ? (settings?.catalogs[role.provider] ?? null) : null;
  const selectedModel =
    role && catalog
      ? (catalog.models.find((model) => model.id === role.model) ?? null)
      : null;
  const filteredModels = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!catalog || !query) return catalog?.models ?? [];
    return catalog.models.filter((model) =>
      [model.id, model.label, model.description].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [catalog, modelSearch]);
  const canSave =
    settings &&
    draftRoles &&
    ROLES.every((candidateRole) =>
      isValidRole(
        draftRoles[candidateRole],
        settings.catalogs[draftRoles[candidateRole].provider],
      ),
    );

  const updateRole = useMemoizedFn(
    (
      targetRole: AgentTeamRole,
      updater: (current: AgentTeamRoleModelConfig) => AgentTeamRoleModelConfig,
    ): void => {
      setDraftRoles((current) =>
        current
          ? { ...current, [targetRole]: updater(current[targetRole]) }
          : current,
      );
    },
  );

  const selectRole = useMemoizedFn((nextRole: AgentTeamRole): void => {
    setSelectedRole(nextRole);
    setModelSearch("");
  });

  const selectProvider = useMemoizedFn(
    (provider: AgentTeamModelProvider): void => {
      if (settings?.catalogs[provider].availability !== "available") return;
      updateRole(selectedRole, () => createEmptyRole(provider));
      setModelSearch("");
    },
  );

  const selectModel = useMemoizedFn((model: AgentTeamCatalogModel): void => {
    updateRole(selectedRole, (current) =>
      current.provider === "codex"
        ? {
            provider: "codex",
            model: model.id,
            reasoningEffort: model.defaultReasoningEffort,
            fast: false,
          }
        : {
            provider: "traex",
            model: model.id,
            reasoningEffort: model.defaultReasoningEffort,
            max: false,
          },
    );
  });

  const selectReasoning = useMemoizedFn(
    (reasoningEffort: string | null): void => {
      updateRole(selectedRole, (current) => ({
        ...current,
        reasoningEffort,
      }));
    },
  );

  const toggleAdvanced = useMemoizedFn((): void => {
    setAdvancedOpenByRole((current) => ({
      ...current,
      [selectedRole]: !current[selectedRole],
    }));
  });

  const toggleCapability = useMemoizedFn((): void => {
    updateRole(selectedRole, (current) =>
      current.provider === "codex"
        ? { ...current, fast: !current.fast }
        : { ...current, max: !current.max },
    );
  });

  const close = useMemoizedFn((): void => {
    onOpenChange(false);
  });

  const save = useMemoizedFn(async (): Promise<void> => {
    if (!draftRoles || !canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await saveAgentTeamModelSettings(apiBase, token, {
        roles: draftRoles,
      });
      setSettings(response);
      setDraftRoles(structuredClone(response.config?.roles ?? draftRoles));
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  });

  const handleOpenChange = useMemoizedFn((nextOpen: boolean): void => {
    onOpenChange(nextOpen);
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[min(760px,88vh)] max-w-5xl flex-col gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100">
        <DialogHeader className="border-b border-slate-800 px-6 py-5">
          <div className="flex items-center gap-3">
            <DialogTitle>Agent Team 模型配置</DialogTitle>
            <span className="rounded border border-indigo-400/30 bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-300">
              全局
            </span>
          </div>
          <DialogDescription className="sr-only">
            配置 Agent Team 四个角色的 CLI、模型和能力参数。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取模型目录…
          </div>
        ) : settings && draftRoles && role && catalog ? (
          <div className="grid min-h-0 flex-1 grid-cols-[280px_minmax(0,1fr)]">
            <aside className="min-h-0 overflow-y-auto border-r border-slate-800 bg-slate-950/70 p-4">
              <div className="space-y-2">
                {ROLES.map((candidateRole) => {
                  const candidate = draftRoles[candidateRole];
                  const candidateCatalog =
                    settings.catalogs[candidate.provider];
                  const candidateModel = candidateCatalog.models.find(
                    (model) => model.id === candidate.model,
                  );
                  const active = candidateRole === selectedRole;
                  return (
                    <button
                      key={candidateRole}
                      type="button"
                      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${
                        active
                          ? "border-indigo-500/50 bg-indigo-500/10"
                          : "border-transparent hover:bg-slate-900"
                      }`}
                      onClick={() => selectRole(candidateRole)}
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-slate-800 text-xs font-semibold text-slate-300">
                        {ROLE_META[candidateRole].shortLabel}
                      </span>
                      <span className="min-w-0">
                        <strong className="block text-sm font-medium">
                          {ROLE_META[candidateRole].label}
                        </strong>
                        <span className="mt-1 block truncate text-xs text-slate-500">
                          {formatRoleSummary(
                            candidate,
                            candidateCatalog,
                            candidateModel,
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-5 text-xs leading-5 text-slate-500">
                每个角色独立保存
                CLI、模型和能力参数。模型列表来自当前连接上已安装的 CLI。
              </p>
            </aside>

            <section className="min-h-0 overflow-y-auto p-6">
              <div>
                <h2 className="text-lg font-semibold">
                  {ROLE_META[selectedRole].label}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {ROLE_META[selectedRole].intent}
                </p>
              </div>

              <div className="mt-6 space-y-6">
                <Field label="CLI" hint="运行时会把下列配置编译为 CLI 参数">
                  <div className="grid grid-cols-2 rounded-lg bg-slate-900 p-1">
                    {(["codex", "traex"] as const).map((provider) => {
                      const providerCatalog = settings.catalogs[provider];
                      return (
                        <button
                          key={provider}
                          type="button"
                          disabled={
                            providerCatalog.availability !== "available"
                          }
                          aria-pressed={role.provider === provider}
                          className={`rounded-md px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                            role.provider === provider
                              ? "bg-slate-700 text-white"
                              : "text-slate-400 hover:text-slate-200"
                          }`}
                          onClick={() => selectProvider(provider)}
                        >
                          {provider === "codex" ? "Codex" : "TraeX"}
                          {providerCatalog.availability !== "available"
                            ? "（不可用）"
                            : ""}
                        </button>
                      );
                    })}
                  </div>
                </Field>

                <Field
                  label="模型"
                  hint={`${catalog.command} · ${catalog.models.length} 个可用模型`}
                >
                  <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/60">
                    <label className="flex items-center gap-2 border-b border-slate-800 px-3">
                      <Search className="h-4 w-4 text-slate-500" />
                      <input
                        value={modelSearch}
                        className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-600"
                        placeholder={
                          selectedModel
                            ? `搜索模型，当前：${selectedModel.label}`
                            : "搜索并显式选择模型"
                        }
                        onChange={(event) => setModelSearch(event.target.value)}
                      />
                    </label>
                    <div className="max-h-48 overflow-y-auto p-1.5">
                      {filteredModels.length > 0 ? (
                        filteredModels.map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-slate-800"
                            onClick={() => selectModel(model)}
                          >
                            <span className="min-w-0 flex-1">
                              <strong className="block truncate text-sm font-medium">
                                {model.label}
                              </strong>
                              <span className="block truncate text-xs text-slate-500">
                                {model.id}
                              </span>
                            </span>
                            {role.model === model.id ? (
                              <Check className="mt-1 h-4 w-4 text-indigo-400" />
                            ) : null}
                          </button>
                        ))
                      ) : (
                        <p className="px-3 py-6 text-center text-sm text-slate-500">
                          没有匹配的模型
                        </p>
                      )}
                    </div>
                  </div>
                </Field>

                <Field
                  label="Reasoning effort"
                  hint="仅展示当前模型实际支持的档位"
                >
                  {selectedModel?.reasoningEfforts.length ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedModel.reasoningEfforts.map((effort) => (
                        <button
                          key={effort}
                          type="button"
                          aria-pressed={role.reasoningEffort === effort}
                          className={`rounded-md border px-3 py-1.5 text-xs ${
                            role.reasoningEffort === effort
                              ? "border-indigo-400/60 bg-indigo-500/15 text-indigo-200"
                              : "border-slate-700 text-slate-400 hover:border-slate-600"
                          }`}
                          onClick={() => selectReasoning(effort)}
                        >
                          {effort}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">
                      {selectedModel
                        ? "此模型不提供可配置档位"
                        : "请先选择模型"}
                    </p>
                  )}
                </Field>

                <div className="rounded-lg border border-slate-800">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-4 py-3 text-sm"
                    onClick={toggleAdvanced}
                  >
                    高级参数
                    <ChevronDown
                      className={`h-4 w-4 transition-transform ${
                        advancedOpenByRole[selectedRole] ? "rotate-180" : ""
                      }`}
                    />
                  </button>
                  {advancedOpenByRole[selectedRole] ? (
                    <div className="border-t border-slate-800 px-4 py-4">
                      <label className="flex items-center justify-between gap-4">
                        <span>
                          <strong className="block text-sm font-medium">
                            {role.provider === "codex" ? "Fast" : "Max"}
                          </strong>
                          <span className="mt-1 block text-xs text-slate-500">
                            {role.provider === "codex"
                              ? "显式覆盖 Codex Fast 模式"
                              : "显式覆盖 TraeX Max 模式"}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={
                            role.provider === "codex" ? role.fast : role.max
                          }
                          disabled={
                            !selectedModel ||
                            (role.provider === "codex"
                              ? !selectedModel.supportsFast
                              : !selectedModel.supportsMax)
                          }
                          className="h-4 w-4 accent-indigo-500"
                          onChange={toggleCapability}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              </div>
            </section>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-rose-300">
            {error ?? "模型配置不可用"}
          </div>
        )}

        {error && settings ? (
          <div className="border-t border-rose-900/60 bg-rose-950/40 px-6 py-2 text-xs text-rose-300">
            {error}
          </div>
        ) : null}
        <DialogFooter className="border-t border-slate-800 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={close}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!canSave || saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? "保存中…" : "保存全局配置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-slate-500">{hint}</span>
      </div>
      {children}
    </div>
  );
}

function createEmptyRoleMap(
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

function createEmptyRole(
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

function isValidRole(
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

function formatRoleSummary(
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
