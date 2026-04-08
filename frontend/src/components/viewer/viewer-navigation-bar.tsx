import type { NavigationState } from "@browser-viewer/shared";
import { ArrowLeft, ArrowRight, Globe, Lock, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "../ui/button";
import type { ViewerSecurityState } from "../../features/viewer/viewer-security";

interface ViewerNavigationBarProps {
  activeTabId: string | null;
  activeNavigation: NavigationState | undefined;
  addressInput: string;
  securityState: ViewerSecurityState;
  disabled: boolean;
  onAddressFocus: () => void;
  onAddressChange: (value: string) => void;
  onAddressBlur: () => void;
  onAddressSubmit: () => void;
  onAddressCancel: () => void;
  onNavigationAction: (action: "back" | "forward" | "reload" | "stop") => void;
}

export function ViewerNavigationBar({
  activeTabId,
  activeNavigation,
  addressInput,
  securityState,
  disabled,
  onAddressFocus,
  onAddressChange,
  onAddressBlur,
  onAddressSubmit,
  onAddressCancel,
  onNavigationAction,
}: ViewerNavigationBarProps) {
  const securityToneClass =
    securityState.tone === "secure"
      ? "border-emerald-500/25 bg-emerald-500/12 text-emerald-200"
      : securityState.tone === "insecure"
        ? "border-amber-500/25 bg-amber-500/12 text-amber-200"
        : "border-white/10 bg-white/5 text-stone-300";

  const SecurityIcon =
    securityState.tone === "secure"
      ? Lock
      : securityState.tone === "insecure"
        ? TriangleAlert
        : Globe;

  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full border border-white/10 bg-white/5 px-3 text-stone-200 hover:bg-white/8 hover:text-white"
          aria-label="Back"
          title="Back"
          disabled={disabled || !activeTabId || !activeNavigation?.canGoBack}
          onClick={() => {
            if (!activeTabId || !activeNavigation?.canGoBack) {
              return;
            }
            onNavigationAction("back");
          }}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full border border-white/10 bg-white/5 px-3 text-stone-200 hover:bg-white/8 hover:text-white"
          aria-label="Forward"
          title="Forward"
          disabled={
            disabled || !activeTabId || !activeNavigation?.canGoForward
          }
          onClick={() => {
            if (!activeTabId || !activeNavigation?.canGoForward) {
              return;
            }
            onNavigationAction("forward");
          }}
        >
          <ArrowRight className="h-4 w-4" />
        </Button>
        {activeNavigation?.isLoading ? (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full border border-white/10 bg-white/5 px-3 text-stone-200 hover:bg-white/8 hover:text-white"
            aria-label="Refresh"
            title="Refresh"
            disabled={disabled || !activeTabId}
            onClick={() => {
              if (!activeTabId) {
                return;
              }
              onNavigationAction("stop");
            }}
          >
            <RefreshCw className="h-4 w-4 animate-spin" />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full border border-white/10 bg-white/5 px-3 text-stone-200 hover:bg-white/8 hover:text-white"
            aria-label="Refresh"
            title="Refresh"
            disabled={disabled || !activeTabId}
            onClick={() => {
              if (!activeTabId) {
                return;
              }
              onNavigationAction("reload");
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-xs font-medium ${securityToneClass}`}
        >
          <SecurityIcon className="h-4 w-4 shrink-0" />
          <span className="hidden sm:inline">{securityState.label}</span>
          {securityState.hostname ? (
            <span className="max-w-40 truncate text-[11px] text-current/80">
              {securityState.hostname}
            </span>
          ) : null}
        </div>

        <input
          data-testid="address-input"
          value={addressInput}
          onFocus={onAddressFocus}
          onChange={(event) => onAddressChange(event.target.value)}
          onBlur={onAddressBlur}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAddressSubmit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              onAddressCancel();
            }
          }}
          className="h-11 min-w-0 flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-white outline-none transition placeholder:text-stone-400 focus:border-primary/45"
          placeholder="https://example.com"
          disabled={disabled}
        />
      </div>
    </div>
  );
}
