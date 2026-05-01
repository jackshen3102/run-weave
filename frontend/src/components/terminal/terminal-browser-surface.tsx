import { Globe2 } from "lucide-react";
import type { RefObject } from "react";
import type { TerminalBrowserHeaderRule } from "@browser-viewer/shared";
import { TerminalBrowserHeadersPanel } from "./terminal-browser-headers-panel";
import { Button } from "../ui/button";

const BROWSER_VIEW_GUTTER_PX = 6;
const TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX = 320;

interface TerminalBrowserSurfaceProps {
  surfaceRef: RefObject<HTMLDivElement | null>;
  isElectron: boolean;
  headerRulesPanelOpen: boolean;
  headerRules: TerminalBrowserHeaderRule[];
  headerSaving: boolean;
  headerError: string | null;
  onCloseHeaderRulesPanel: () => void;
  onSaveHeaderRules: (rules: TerminalBrowserHeaderRule[]) => Promise<boolean>;
  onReload: () => void;
  onOpenExternal: () => void;
}

export function TerminalBrowserSurface({
  surfaceRef,
  isElectron,
  headerRulesPanelOpen,
  headerRules,
  headerSaving,
  headerError,
  onCloseHeaderRulesPanel,
  onSaveHeaderRules,
  onReload,
  onOpenExternal,
}: TerminalBrowserSurfaceProps) {
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={surfaceRef}
        className="absolute inset-y-0 right-0"
        style={{
          left: BROWSER_VIEW_GUTTER_PX,
          right: headerRulesPanelOpen
            ? TERMINAL_BROWSER_SIDE_PANEL_WIDTH_PX
            : 0,
        }}
      />
      {isElectron ? (
        <TerminalBrowserHeadersPanel
          open={headerRulesPanelOpen}
          rules={headerRules}
          saving={headerSaving}
          error={headerError}
          onClose={onCloseHeaderRulesPanel}
          onSave={onSaveHeaderRules}
          onReload={onReload}
        />
      ) : null}
      {!isElectron ? (
        <div
          className="absolute inset-y-0 right-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-xs text-slate-400"
          style={{ left: BROWSER_VIEW_GUTTER_PX }}
        >
          <Globe2 className="h-8 w-8 text-slate-500" />
          <p>Local browser is available in the desktop app.</p>
          <Button
            type="button"
            size="sm"
            className="rounded-md"
            onClick={onOpenExternal}
          >
            Open in system browser
          </Button>
        </div>
      ) : null}
    </div>
  );
}
