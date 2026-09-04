import { useMemoizedFn } from "ahooks";
import { useEffect, useRef, useState } from "react";
import {
  TERMINAL_BROWSER_PROFILE_CONFIGS,
  type TerminalBrowserProfileId,
  type TerminalBrowserProfilePreferences,
  type TerminalBrowserProfileRuntimeState,
} from "@runweave/shared/terminal-browser-profile";
import { Settings2 } from "lucide-react";
import { useTerminalPreviewStore } from "../../../../features/terminal/preview/store";
import { Button } from "../../../ui/button";
import { TerminalBrowserProfileSettings } from "./profile-settings";

interface TerminalBrowserProfileStatusProps {
  profileId: TerminalBrowserProfileId;
  projectId: string | null;
  resolving: boolean;
  resolutionError: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TerminalBrowserProfileStatus({
  profileId,
  projectId,
  resolving,
  resolutionError,
  open,
  onOpenChange,
}: TerminalBrowserProfileStatusProps) {
  const [preferences, setPreferences] =
    useState<TerminalBrowserProfilePreferences | null>(null);
  const [runtime, setRuntime] =
    useState<TerminalBrowserProfileRuntimeState | null>(null);
  const [proxySwitching, setProxySwitching] = useState(false);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activateBrowser = useTerminalPreviewStore(
    (state) => state.activateBrowser,
  );
  const config = TERMINAL_BROWSER_PROFILE_CONFIGS[profileId];

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.electronAPI?.terminalBrowserGetProfilePreferences?.(),
      window.electronAPI?.terminalBrowserGetProfileRuntimes?.(),
    ]).then(([nextPreferences, runtimes]) => {
      if (cancelled) return;
      if (nextPreferences) setPreferences(nextPreferences);
      setRuntime(
        runtimes?.find((item) => item.profileId === profileId) ?? null,
      );
    });
    const unsubscribe = window.electronAPI?.onTerminalBrowserProfileChanged?.(
      (event) => {
        if (event.kind === "preferences") {
          setPreferences(event.preferences);
        } else if (event.runtime.profileId === profileId) {
          setRuntime(event.runtime);
        }
      },
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [profileId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [onOpenChange, open]);

  const proxyEnabled = runtime?.proxyMode !== "direct";
  const toggleProxy = useMemoizedFn(async () => {
    if (!runtime || proxySwitching) {
      return;
    }
    setProxySwitching(true);
    setProxyError(null);
    try {
      const next =
        await window.electronAPI?.terminalBrowserSetProfileProxyMode?.(
          profileId,
          proxyEnabled ? "direct" : "whistle",
        );
      if (!next) {
        throw new Error("Profile proxy control is unavailable");
      }
      setRuntime(next);
      activateBrowser(profileId, projectId);
    } catch (error) {
      setProxyError(
        error instanceof Error ? error.message : "Failed to switch proxy",
      );
    } finally {
      setProxySwitching(false);
    }
  });

  const status = resolving
    ? "starting"
    : (runtime?.whistle.status ?? "stopped");
  const statusClass = resolutionError
    ? "bg-rose-500"
    : !proxyEnabled
      ? "bg-slate-500"
      : status === "ready"
        ? "bg-emerald-400"
        : status === "failed"
          ? "bg-rose-500"
          : "bg-amber-400";
  const routeLabel =
    runtime?.route.kind === "dev-server"
      ? `127.0.0.1:${runtime.route.port}`
      : "Unassigned";

  return (
    <div ref={containerRef} className="relative">
      <Button
        data-testid="terminal-browser-profile-status"
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-1.5 text-[10px]"
        aria-expanded={open}
        aria-label={`${config.label}: ${proxyEnabled ? "proxy enabled" : "direct connection"}`}
        title={proxyEnabled ? "Whistle proxy enabled" : "Direct connection"}
        onClick={() => onOpenChange(!open)}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${statusClass}`} />
        {config.shortLabel}
        <Settings2 className="h-3 w-3" />
      </Button>
      {open ? (
        <div className="absolute right-0 top-8 z-50 w-80 rounded-md border border-slate-700 bg-slate-900 p-3 shadow-xl">
          <div className="space-y-1 text-[11px]">
            <div className="flex justify-between gap-3 text-slate-200">
              <strong>{config.label}</strong>
              <span>{proxyEnabled ? "Proxy" : "Direct"}</span>
            </div>
            <div className="flex items-center justify-between gap-3 text-slate-400">
              <span>Connection</span>
              <Button
                data-testid="terminal-browser-profile-proxy-toggle"
                type="button"
                size="sm"
                variant="ghost"
                className={[
                  "h-6 min-w-16 px-2 text-[10px]",
                  proxyEnabled
                    ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20"
                    : "bg-slate-700 text-slate-200 hover:bg-slate-600",
                ].join(" ")}
                disabled={!runtime || resolving || proxySwitching}
                aria-label={`${config.label} proxy`}
                aria-pressed={proxyEnabled}
                title={
                  proxyEnabled
                    ? "Switch this Profile to a direct connection"
                    : "Enable the Whistle proxy for this Profile"
                }
                onClick={() => void toggleProxy()}
              >
                {proxySwitching
                  ? "Switching…"
                  : proxyEnabled
                    ? "Enabled"
                    : "Direct"}
              </Button>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Whistle</span>
              <span>
                {status} · 127.0.0.1:{config.whistlePort}
              </span>
            </div>
            <div className="flex justify-between text-slate-400">
              <span>Route</span>
              <span data-testid="terminal-browser-route">{routeLabel}</span>
            </div>
            {proxyError ? (
              <p className="break-words text-rose-300">{proxyError}</p>
            ) : resolutionError ? (
              <p className="break-words text-rose-300">{resolutionError}</p>
            ) : proxyEnabled && runtime?.whistle.error ? (
              <p className="break-words text-rose-300">
                {runtime.whistle.error.code}: {runtime.whistle.error.message}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 w-full"
              onClick={() => {
                void window.electronAPI?.terminalBrowserOpenWhistleConsole?.(
                  profileId,
                );
              }}
            >
              Open Whistle Console
            </Button>
          </div>
          {preferences ? (
            <TerminalBrowserProfileSettings
              profileId={profileId}
              projectId={projectId}
              preferences={preferences}
              onPreferencesChange={setPreferences}
              onReactivate={() => activateBrowser(profileId, projectId)}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
