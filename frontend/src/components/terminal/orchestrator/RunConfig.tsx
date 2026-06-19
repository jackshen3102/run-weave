import type { OrchestratorRoleDefinition, TerminalSessionListItem } from "@runweave/shared";
import { Button } from "../../ui/button";
import { AgentCliSelect } from "./AgentCliSelect";
import { BindingControls } from "./BindingControls";
import type { AgentCliCommand, RoleDraft } from "./types";
import { normalizeAgentCliCommand } from "./utils";

export function RunConfig(props: {
  task: string;
  startupPrompt: string;
  orchestratorCommand: AgentCliCommand;
  orchestratorMode: "new" | "reuse";
  orchestratorSessionId: string;
  requireHumanConfirmationEachRound: boolean;
  projectSessions: TerminalSessionListItem[];
  roles: OrchestratorRoleDefinition[];
  roleDrafts: Record<string, RoleDraft>;
  roleLibraryOpen: boolean;
  loading: boolean;
  restartMode: boolean;
  onTaskChange: (value: string) => void;
  onStartupPromptChange: (value: string) => void;
  onOrchestratorCommandChange: (value: AgentCliCommand) => void;
  onOrchestratorModeChange: (value: "new" | "reuse") => void;
  onOrchestratorSessionChange: (value: string) => void;
  onRequireHumanConfirmationEachRoundChange: (value: boolean) => void;
  onRoleDraftChange: (roleId: string, patch: Partial<RoleDraft>) => void;
  onToggleRoleLibrary: () => void;
  onRoleChange: (
    roleId: string,
    patch: Partial<OrchestratorRoleDefinition>,
  ) => void;
  onCancelRestart: () => void;
  onSaveRoleLibrary: () => void;
  onStart: () => void;
}) {
  return (
    <div className="space-y-4">
      {props.restartMode ? (
        <div className="flex items-center gap-2 rounded-md border border-sky-700/70 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">
          <span className="min-w-0 flex-1">已带入上一次流程配置，可直接开始新的 Run。</span>
          <button
            type="button"
            className="shrink-0 text-sky-300 hover:text-sky-100"
            onClick={props.onCancelRestart}
          >
            取消
          </button>
        </div>
      ) : null}
      <label className="block text-xs text-slate-400">
        <span className="mb-1 block">任务/计划</span>
        <textarea
          value={props.task}
          onChange={(event) => props.onTaskChange(event.target.value)}
          className="min-h-24 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-600"
        />
      </label>
      <section className="space-y-2">
        <div className="text-xs font-medium text-slate-300">主 Agent</div>
        <AgentCliSelect
          value={props.orchestratorCommand}
          onChange={props.onOrchestratorCommandChange}
        />
        <BindingControls
          mode={props.orchestratorMode}
          sessionId={props.orchestratorSessionId}
          sessions={props.projectSessions}
          onModeChange={props.onOrchestratorModeChange}
          onSessionChange={props.onOrchestratorSessionChange}
        />
        <textarea
          value={props.startupPrompt}
          onChange={(event) => props.onStartupPromptChange(event.target.value)}
          className="min-h-20 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
        />
        <label className="flex items-center gap-2 rounded-md border border-slate-800 px-3 py-2 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={props.requireHumanConfirmationEachRound}
            onChange={(event) =>
              props.onRequireHumanConfirmationEachRoundChange(
                event.target.checked,
              )
            }
          />
          <span className="min-w-0 flex-1">每一轮都需要人工确认</span>
        </label>
      </section>
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 text-xs font-medium text-slate-300">
            参与角色
          </div>
          <button
            type="button"
            className="text-xs text-sky-300 hover:text-sky-200"
            onClick={props.onToggleRoleLibrary}
          >
            管理全局角色定义
          </button>
        </div>
        {props.roleLibraryOpen ? (
          <div className="space-y-3 border-y border-slate-800 py-3">
            {props.roles.map((role) => (
              <div key={role.id} className="space-y-2">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
                  <input
                    value={role.name}
                    onChange={(event) =>
                      props.onRoleChange(role.id, { name: event.target.value })
                    }
                    className="h-8 min-w-0 rounded-md border border-slate-800 bg-slate-950 px-2 text-xs outline-none focus:border-sky-600"
                  />
                  <AgentCliSelect
                    value={normalizeAgentCliCommand(role.terminal.command)}
                    onChange={(command) =>
                      props.onRoleChange(role.id, {
                        terminal: {
                          ...role.terminal,
                          command,
                          args: [],
                        },
                      })
                    }
                  />
                </div>
                <textarea
                  value={role.prompt}
                  onChange={(event) =>
                    props.onRoleChange(role.id, { prompt: event.target.value })
                  }
                  className="min-h-16 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
                />
                <input
                  value={role.skill ?? ""}
                  placeholder="驱动技能（可选，如 review-only）"
                  onChange={(event) =>
                    props.onRoleChange(role.id, { skill: event.target.value })
                  }
                  className="h-8 w-full rounded-md border border-slate-800 bg-slate-950 px-2 text-xs outline-none focus:border-sky-600"
                />
              </div>
            ))}
            <Button
              type="button"
              variant="secondary"
              className="h-8 w-full rounded-md text-xs"
              disabled={props.loading}
              onClick={props.onSaveRoleLibrary}
            >
              保存角色定义
            </Button>
          </div>
        ) : null}
        {props.roles.map((role) => {
          const draft = props.roleDrafts[role.id];
          return (
            <div key={role.id} className="space-y-2 border-t border-slate-800 py-2">
              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  checked={draft?.selected ?? true}
                  onChange={(event) =>
                    props.onRoleDraftChange(role.id, {
                      selected: event.target.checked,
                    })
                  }
                />
                <span>{role.name}</span>
                <span className="text-slate-500">{role.id}</span>
              </label>
              <BindingControls
                mode={draft?.bindingMode ?? "new"}
                sessionId={draft?.sessionId ?? ""}
                sessions={props.projectSessions}
                onModeChange={(mode) =>
                  props.onRoleDraftChange(role.id, { bindingMode: mode })
                }
                onSessionChange={(sessionId) =>
                  props.onRoleDraftChange(role.id, { sessionId })
                }
              />
              <textarea
                value={draft?.prompt ?? role.prompt}
                onChange={(event) =>
                  props.onRoleDraftChange(role.id, {
                    prompt: event.target.value,
                  })
                }
                className="min-h-16 w-full resize-y rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none focus:border-sky-600"
              />
              <input
                value={draft?.skill ?? role.skill ?? ""}
                placeholder="驱动技能（可选，如 review-only）"
                onChange={(event) =>
                  props.onRoleDraftChange(role.id, {
                    skill: event.target.value,
                  })
                }
                className="h-8 w-full rounded-md border border-slate-800 bg-slate-950 px-2 text-xs outline-none focus:border-sky-600"
              />
            </div>
          );
        })}
      </section>
      <Button
        type="button"
        className="h-8 w-full rounded-md text-xs"
        disabled={props.loading || !props.task.trim()}
        onClick={props.onStart}
      >
        开始 Run
      </Button>
    </div>
  );
}
