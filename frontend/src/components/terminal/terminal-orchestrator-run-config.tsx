import type {
  OrchestratorRoleDefinition,
  TerminalSessionListItem,
} from "@runweave/shared";
import { formatTerminalSessionName } from "../../features/terminal/session-name";
import { Button } from "../ui/button";

export type AgentCliCommand = "codex" | "traex";

const AGENT_CLI_OPTIONS: Array<{ value: AgentCliCommand; label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "traex", label: "Traex" },
];

export interface RoleDraft {
  selected: boolean;
  bindingMode: "new" | "reuse";
  sessionId: string;
  prompt: string;
}

function AgentCliSelect(props: {
  value: AgentCliCommand;
  onChange: (value: AgentCliCommand) => void;
}) {
  return (
    <select
      value={props.value}
      onChange={(event) =>
        props.onChange(normalizeAgentCliCommand(event.target.value))
      }
      className="h-8 w-full rounded-md border border-slate-800 bg-slate-950 px-2 text-xs text-slate-100 outline-none focus:border-sky-600"
    >
      {AGENT_CLI_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function RunConfig(props: {
  task: string;
  startupPrompt: string;
  orchestratorCommand: AgentCliCommand;
  orchestratorMode: "new" | "reuse";
  orchestratorSessionId: string;
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

function BindingControls(props: {
  mode: "new" | "reuse";
  sessionId: string;
  sessions: TerminalSessionListItem[];
  onModeChange: (mode: "new" | "reuse") => void;
  onSessionChange: (sessionId: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
      <label className="inline-flex items-center gap-1">
        <input
          type="radio"
          checked={props.mode === "new"}
          onChange={() => props.onModeChange("new")}
        />
        新建终端
      </label>
      <label className="inline-flex items-center gap-1">
        <input
          type="radio"
          checked={props.mode === "reuse"}
          onChange={() => props.onModeChange("reuse")}
        />
        复用
      </label>
      <select
        value={props.sessionId}
        disabled={props.mode !== "reuse"}
        onChange={(event) => props.onSessionChange(event.target.value)}
        className="h-7 min-w-0 flex-1 rounded-md border border-slate-800 bg-slate-950 px-2 text-xs outline-none focus:border-sky-600 disabled:opacity-50"
      >
        <option value="">选择终端</option>
        {props.sessions.map((session) => (
          <option key={session.terminalSessionId} value={session.terminalSessionId}>
            {formatTerminalSessionName({
              alias: session.alias,
              cwd: session.cwd,
              activeCommand: session.activeCommand,
            })}
          </option>
        ))}
      </select>
    </div>
  );
}

export function normalizeAgentCliCommand(
  value: string | undefined,
): AgentCliCommand {
  return value === "traex" ? "traex" : "codex";
}
