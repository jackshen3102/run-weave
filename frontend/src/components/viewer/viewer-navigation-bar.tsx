import type { NavigationState } from "@browser-viewer/shared";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "../ui/button";

interface ViewerNavigationBarProps {
  activeTabId: string | null;
  activeNavigation: NavigationState | undefined;
  addressInput: string;
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
  onAddressFocus,
  onAddressChange,
  onAddressBlur,
  onAddressSubmit,
  onAddressCancel,
  onNavigationAction,
}: ViewerNavigationBarProps) {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full border border-white/10 bg-white/5 px-3 text-stone-200 hover:bg-white/8 hover:text-white"
          aria-label="Back"
          title="Back"
          disabled={!activeTabId || !activeNavigation?.canGoBack}
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
          disabled={!activeTabId || !activeNavigation?.canGoForward}
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
            disabled={!activeTabId}
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
            disabled={!activeTabId}
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
        className="h-11 flex-1 rounded-full border border-white/10 bg-white/5 px-4 text-sm text-white outline-none transition placeholder:text-stone-400 focus:border-primary/45"
        placeholder="https://example.com"
      />
    </div>
  );
}
