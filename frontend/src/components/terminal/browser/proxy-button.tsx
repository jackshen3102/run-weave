import { useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import {
  isValidTerminalBrowserProxyPort,
  TERMINAL_BROWSER_PROXY_HOST,
  TERMINAL_BROWSER_PROXY_MAX_PORT,
  TERMINAL_BROWSER_PROXY_MIN_PORT,
  type TerminalBrowserProxyState,
} from "@runweave/shared/terminal-browser-proxy";
import { Button } from "../../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";

interface TerminalBrowserProxyButtonProps {
  state: TerminalBrowserProxyState | null;
  switching: boolean;
  disabled: boolean;
  onToggle: () => void;
  onSetPort: (port: number) => Promise<boolean>;
}

export function TerminalBrowserProxyButton({
  state,
  switching,
  disabled,
  onToggle,
  onSetPort,
}: TerminalBrowserProxyButtonProps) {
  const [open, setOpen] = useState(false);
  const [portDraft, setPortDraft] = useState("");
  const [portError, setPortError] = useState<string | null>(null);

  const enabled = state?.enabled ?? false;
  const port = state?.port;

  useEffect(() => {
    if (open && typeof port === "number") {
      setPortDraft(String(port));
      setPortError(null);
    }
  }, [open, port]);

  const savePort = async (): Promise<void> => {
    const parsed = Number(portDraft.trim());
    if (!isValidTerminalBrowserProxyPort(parsed)) {
      setPortError(
        `端口需为 ${TERMINAL_BROWSER_PROXY_MIN_PORT}–${TERMINAL_BROWSER_PROXY_MAX_PORT} 的整数`,
      );
      return;
    }
    setPortError(null);
    const didSave = await onSetPort(parsed);
    if (didSave) {
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={[
            "h-7 w-7 rounded-md px-0",
            enabled
              ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-200"
              : "",
          ].join(" ")}
          disabled={disabled}
          aria-label="Browser proxy settings"
          title={
            enabled && state
              ? `Proxy enabled: ${state.proxyRules}`
              : "Browser proxy settings"
          }
        >
          {enabled ? (
            <Wifi className="h-4 w-4" />
          ) : (
            <WifiOff className="h-4 w-4" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-200">本地代理</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={[
                "h-6 rounded-md px-2 text-[11px]",
                enabled
                  ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/20"
                  : "text-slate-300",
              ].join(" ")}
              disabled={switching}
              onClick={onToggle}
            >
              {enabled ? "已开启" : "已关闭"}
            </Button>
          </div>

          <label className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2">
            <span className="text-[10px] font-medium text-slate-500">Host</span>
            <span className="text-xs text-slate-400">
              {TERMINAL_BROWSER_PROXY_HOST}
            </span>
          </label>

          <label className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-2">
            <span className="text-[10px] font-medium text-slate-500">Port</span>
            <input
              className={[
                "h-8 w-full rounded-md border bg-slate-900 px-2 text-xs text-slate-100 outline-none focus:border-emerald-500",
                portError ? "border-rose-700" : "border-slate-800",
              ].join(" ")}
              inputMode="numeric"
              value={portDraft}
              onChange={(event) => setPortDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void savePort();
                }
              }}
            />
          </label>

          {portError ? (
            <p className="text-xs text-rose-400">{portError}</p>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              className="h-8 rounded-md px-3 text-xs"
              disabled={switching}
              onClick={() => void savePort()}
            >
              保存
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
