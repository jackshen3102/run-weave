import { useEffect, useState } from "react";
import {
  TERMINAL_BROWSER_PROFILE_CONFIGS,
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfilePreferenceUpdate,
  type TerminalBrowserProfilePreferences,
} from "@runweave/shared/terminal-browser-profile";
import { Button } from "../../../ui/button";

interface TerminalBrowserProfileSettingsProps {
  profileId: TerminalBrowserProfileId;
  projectId: string | null;
  preferences: TerminalBrowserProfilePreferences;
  onPreferencesChange: (
    preferences: TerminalBrowserProfilePreferences,
    update: TerminalBrowserProfilePreferenceUpdate,
  ) => void;
}

export function TerminalBrowserProfileSettings({
  profileId,
  projectId,
  preferences,
  onPreferencesChange,
}: TerminalBrowserProfileSettingsProps) {
  const profilePort = preferences.profilePorts[profileId];
  const pendingPorts = preferences.pendingPortMigration[profileId] ?? [];
  const worktree = projectId ? preferences.worktrees[projectId] : undefined;
  const [devServerPort, setDevServerPort] = useState(
    profilePort ? String(profilePort) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDevServerPort(
      profilePort ? String(profilePort) : "",
    );
  }, [profilePort]);

  const update = async (
    value: TerminalBrowserProfilePreferenceUpdate,
  ): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const next =
        await window.electronAPI?.terminalBrowserUpdateProfilePreferences?.(
          value,
        );
      if (!next) throw new Error("Profile preferences are unavailable");
      onPreferencesChange(next, value);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to save settings",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-slate-800 pt-3">
      <p className="text-[11px] font-medium text-slate-200">Browser selection</p>
      <label className="block space-y-1 text-[11px] text-slate-400">
        <span>Global default</span>
        <select
          data-testid="terminal-browser-global-default"
          className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
          value={preferences.defaultProfileId}
          disabled={saving}
          onChange={(event) => {
            void update({
              scope: "global",
              defaultProfileId: event.target.value as TerminalBrowserProfileId,
            });
          }}
        >
          {TERMINAL_BROWSER_PROFILE_IDS.map((id) => (
            <option key={id} value={id}>
              {TERMINAL_BROWSER_PROFILE_CONFIGS[id].label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-[10px] text-slate-500">用于未设置首选的 Worktree；修改后不切换当前 Browser。</p>
      {projectId ? (
        <div className="space-y-2">
          <label className="block space-y-1 text-[11px] text-slate-400">
            <span>Current Worktree</span>
            <select
              data-testid="terminal-browser-worktree-profile"
              className="h-7 w-full rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
              value={worktree?.preferredProfileId ?? ""}
              disabled={saving}
              onChange={(event) => {
                void update({
                  scope: "worktree",
                  projectId,
                  preferredProfileId:
                    event.target.value === ""
                      ? null
                      : (event.target.value as TerminalBrowserProfileId),
                });
              }}
            >
              <option value="">Follow global default</option>
              {TERMINAL_BROWSER_PROFILE_IDS.map((id) => (
                <option key={id} value={id}>
                  {TERMINAL_BROWSER_PROFILE_CONFIGS[id].label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-[10px] text-slate-500">选择后立即打开该 Browser；开发端口仍属于 Browser。</p>
        </div>
      ) : (
        <p className="text-[10px] text-slate-500">
          选择项目后可设置首选 Browser。代理设置始终属于当前 Browser。
        </p>
      )}
      <div className="border-t border-slate-800 pt-3">
        <p className="text-[11px] font-medium text-slate-200">{TERMINAL_BROWSER_PROFILE_CONFIGS[profileId].label} network</p>
      </div>
      {pendingPorts.length>0 && <div role="status" className="space-y-2 rounded border border-amber-500/40 p-2 text-xs text-amber-300"><p>发现旧项目端口，请选择此 Browser 的固定目标，或在下方留空后点击 Apply。</p><div className="flex gap-2">{pendingPorts.map(port=><Button key={port} size="sm" variant="outline" disabled={saving} onClick={()=>{void update({scope:'profile',profileId,devServerPort:port});}}>{port}</Button>)}</div></div>}
          <label className="block space-y-1 text-[11px] text-slate-400">
            <span>Configured development target · local port</span>
            <div className="flex gap-1">
              <input
                data-testid="terminal-browser-dev-server-port"
                className="h-7 min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
                inputMode="numeric"
                placeholder="5173"
                value={devServerPort}
                disabled={saving}
                onChange={(event) => setDevServerPort(event.target.value)}
              />
              <Button
                type="button"
                size="sm"
                className="h-7"
                disabled={saving}
                onClick={() => {
                  void update({
                    scope: "profile",
                    profileId,
                    devServerPort:
                      devServerPort.trim() === ""
                        ? null
                        : Number(devServerPort),
                  });
                }}
              >
                Apply
              </Button>
            </div>
          </label>
      <p className="text-[10px] text-slate-500">Whistle Rules 决定哪些请求使用该目标；保存端口不会创建规则。目标变化后请刷新相关页面。</p>
      {error ? <p className="text-[10px] text-rose-300">{error}</p> : null}
    </div>
  );
}
