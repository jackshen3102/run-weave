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
    <div
      className="mb-3 flex flex-col gap-2 sm:flex-row"
      data-testid="navigation-bar"
    >
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
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
          variant="secondary"
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
            variant="secondary"
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
            variant="secondary"
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
        className="h-9 flex-1 rounded-md border border-border bg-background px-3 text-sm outline-none ring-primary/30 transition focus:ring-2"
        placeholder="https://example.com"
      />
    </div>
  );
}
