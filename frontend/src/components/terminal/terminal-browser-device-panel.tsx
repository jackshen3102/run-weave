import { Check, Monitor, Smartphone, X } from "lucide-react";
import {
  TERMINAL_BROWSER_DEVICE_PRESETS,
  type TerminalBrowserDevicePresetId,
  type TerminalBrowserDeviceState,
} from "@runweave/shared";
import { Button } from "../ui/button";

interface TerminalBrowserDeviceButtonProps {
  open: boolean;
  deviceState: TerminalBrowserDeviceState;
  switching: boolean;
  onOpenChange: (open: boolean) => void;
}

interface TerminalBrowserDevicePanelProps {
  open: boolean;
  deviceState: TerminalBrowserDeviceState;
  switching: boolean;
  mobileDisabledReason: string | null;
  onClose: () => void;
  onSelectPreset: (presetId: TerminalBrowserDevicePresetId) => void;
}

export function TerminalBrowserDeviceButton({
  open,
  deviceState,
  switching,
  onOpenChange,
}: TerminalBrowserDeviceButtonProps) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={[
        "h-7 w-7 rounded-md px-0",
        open || deviceState.mobile
          ? "bg-sky-500/15 text-sky-300 hover:bg-sky-500/20 hover:text-sky-200"
          : "",
      ].join(" ")}
      disabled={switching}
      aria-label={
        open ? "Close browser device panel" : `Device mode: ${deviceState.label}`
      }
      title={
        open ? "Close browser device panel" : `Device mode: ${deviceState.label}`
      }
      onClick={() => onOpenChange(!open)}
    >
      {deviceState.mobile ? (
        <Smartphone className="h-4 w-4" />
      ) : (
        <Monitor className="h-4 w-4" />
      )}
    </Button>
  );
}

export function TerminalBrowserDevicePanel({
  open,
  deviceState,
  switching,
  mobileDisabledReason,
  onClose,
  onSelectPreset,
}: TerminalBrowserDevicePanelProps) {
  if (!open) {
    return null;
  }

  return (
    <aside className="absolute inset-y-0 right-0 z-10 flex w-[320px] flex-col border-l border-slate-800 bg-slate-950">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-slate-800 px-3">
        <p className="text-xs font-medium text-slate-200">Device</p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 w-7 rounded-md px-0"
          aria-label="Close browser device panel"
          title="Close browser device panel"
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {TERMINAL_BROWSER_DEVICE_PRESETS.map((preset) => {
          const selected = preset.id === deviceState.presetId;
          const disabled = switching || (preset.mobile && !!mobileDisabledReason);
          return (
            <button
              key={preset.id}
              type="button"
              className={[
                "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors",
                selected
                  ? "border-sky-500/60 bg-sky-500/15 text-slate-100"
                  : "border-slate-800 bg-slate-900/50 text-slate-300 hover:bg-slate-900",
                disabled ? "cursor-not-allowed opacity-50" : "",
              ].join(" ")}
              disabled={disabled}
              title={disabled ? (mobileDisabledReason ?? undefined) : preset.label}
              onClick={() => onSelectPreset(preset.id)}
            >
              {preset.mobile ? (
                <Smartphone className="h-4 w-4 shrink-0" />
              ) : (
                <Monitor className="h-4 w-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{preset.label}</span>
              {preset.viewport ? (
                <span className="shrink-0 font-mono text-[11px] text-slate-500">
                  {preset.viewport.width}x{preset.viewport.height}
                </span>
              ) : null}
              {selected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
