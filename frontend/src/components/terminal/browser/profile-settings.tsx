import { useEffect, useState } from "react";
import {
  TERMINAL_BROWSER_PROFILE_CONFIGS,
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfilePreferenceUpdate,
  type TerminalBrowserProfilePreferences,
} from "@runweave/shared/terminal-browser-profile";
import { Button } from "../../ui/button";

interface TerminalBrowserProfileSettingsProps {
  profileId: TerminalBrowserProfileId;
  projectId: string | null;
  preferences: TerminalBrowserProfilePreferences;
  onPreferencesChange: (preferences: TerminalBrowserProfilePreferences) => void;
  onReactivate: () => void;
}

export function TerminalBrowserProfileSettings({
  profileId,
  projectId,
  preferences,
  onPreferencesChange,
  onReactivate,
}: TerminalBrowserProfileSettingsProps) {
  const worktree = projectId ? preferences.worktrees[projectId] : undefined;
  const [businessOrigin, setBusinessOrigin] = useState(
    preferences.businessOrigin ?? "",
  );
  const [devServerPort, setDevServerPort] = useState(
    worktree?.devServerPort ? String(worktree.devServerPort) : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBusinessOrigin(preferences.businessOrigin ?? "");
    setDevServerPort(
      worktree?.devServerPort ? String(worktree.devServerPort) : "",
    );
  }, [preferences.businessOrigin, worktree?.devServerPort]);

  const update = async (
    value: TerminalBrowserProfilePreferenceUpdate,
  ): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const next =
        await window.electronAPI?.terminalBrowserUpdateProfilePreferences?.(
          value,
        );
      if (!next) throw new Error("Profile preferences are unavailable");
      onPreferencesChange(next);
      return true;
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to save settings",
      );
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-t border-slate-800 pt-3">
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
      <label className="block space-y-1 text-[11px] text-slate-400">
        <span>Business origin</span>
        <div className="flex gap-1">
          <input
            data-testid="terminal-browser-business-origin"
            className="h-7 min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-100"
            placeholder="https://example.com"
            value={businessOrigin}
            disabled={saving}
            onChange={(event) => setBusinessOrigin(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            className="h-7"
            disabled={saving}
            onClick={() => {
              void update({ scope: "global", businessOrigin });
            }}
          >
            Save
          </Button>
        </div>
      </label>
      {projectId ? (
        <div className="space-y-2 rounded border border-slate-800 p-2">
          <label className="block space-y-1 text-[11px] text-slate-400">
            <span>Preferred Profile</span>
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
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[11px] text-slate-400">
              Current Worktree
            </span>
            <Button
              data-testid="terminal-browser-use-current-worktree"
              type="button"
              size="sm"
              className="h-7"
              disabled={saving}
              onClick={onReactivate}
            >
              Use {TERMINAL_BROWSER_PROFILE_CONFIGS[profileId].label} for current Worktree
            </Button>
          </div>
          <label className="block space-y-1 text-[11px] text-slate-400">
            <span>Dev Server port</span>
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
                    scope: "worktree",
                    projectId,
                    devServerPort:
                      devServerPort.trim() === ""
                        ? null
                        : Number(devServerPort),
                  }).then((saved) => saved && onReactivate());
                }}
              >
                Apply
              </Button>
            </div>
          </label>
        </div>
      ) : (
        <p className="text-[10px] text-slate-500">
          Select a Worktree to configure its Profile and Dev Server port.
        </p>
      )}
      {error ? <p className="text-[10px] text-rose-300">{error}</p> : null}
    </div>
  );
}
