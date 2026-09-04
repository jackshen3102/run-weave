import {
  useEffect,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Check,
  Copy,
  Maximize2,
  Minimize2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { Button } from "../../ui/button";
import { TerminalBrowserTool } from "../browser/tool";
import type { TerminalSidecarTool } from "../../../features/terminal/preview-store";
import { useTerminalRuntime } from "../../../features/terminal/queries/terminal-runtime-provider";
import {
  TERMINAL_BROWSER_PROFILE_IDS,
  type TerminalBrowserProfileId,
} from "@runweave/shared/terminal-browser-profile";
import { useTerminalPreviewStore } from "../../../features/terminal/preview-store";

interface ActiveProjectLike {
  projectId?: string;
  name?: string;
  path?: string | null;
}

interface SidecarLayout {
  panelWidth: string;
  expanded: boolean;
  onStartResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onToggleExpanded: () => void;
  onClose: () => void;
}

interface SidecarToolNavigation {
  activeTool: TerminalSidecarTool;
  showAgentTeamTool: boolean;
  onSetActiveTool: (tool: TerminalSidecarTool) => void;
}

interface PreviewActions {
  mode: string | null;
  fileLoading: boolean;
  changesLoading: boolean;
  save: {
    loading: boolean;
    disabled: boolean;
    status:
      | "readonly"
      | "editable"
      | "unsaved"
      | "saving"
      | "saved"
      | "conflict";
    available: boolean;
    run: () => void;
  };
  copy: {
    path: string | null;
    copied: boolean;
    run: () => void;
  };
  onRefresh: () => void;
}

interface PreviewNavigation {
  activeProject: ActiveProjectLike | null;
  mode: string | null;
  onSetMode: (mode: "changes" | "file" | "explorer") => void;
}

interface PreviewViewOptions {
  mode: string | null;
  fileKind: string;
  selectedPath: string | null;
  selectedChangePath?: string;
  markdownViewMode: "source" | "split" | "preview";
  svgViewMode: "preview" | "source";
  changesViewMode: "diff" | "preview";
  onSetMarkdown: (nextMode: "source" | "split" | "preview") => void;
  onSetSvg: (nextMode: "preview" | "source") => void;
  onSetChanges: (nextMode: "diff" | "preview") => void;
}

interface TerminalPreviewPanelShellProps {
  actions: PreviewActions;
  activeTerminalSessionId: string | null;
  automationBody?: ReactNode;
  agentTeamBody?: ReactNode;
  raceBody?: ReactNode;
  body: ReactNode;
  layout: SidecarLayout;
  navigation: PreviewNavigation;
  tools: SidecarToolNavigation;
  view: PreviewViewOptions;
}

type SaveStatus =
  | "readonly"
  | "editable"
  | "unsaved"
  | "saving"
  | "saved"
  | "conflict";

function describeMode(mode: string | null | undefined): string {
  if (mode === "file") {
    return "Open";
  }
  if (mode === "explorer") {
    return "Explorer";
  }
  if (mode === "changes") {
    return "Changes";
  }
  return "Preview";
}

export function TerminalPreviewPanelShell({
  actions,
  activeTerminalSessionId,
  automationBody,
  agentTeamBody,
  raceBody,
  body,
  layout,
  navigation,
  tools,
  view,
}: TerminalPreviewPanelShellProps) {
  const { apiBase, token } = useTerminalRuntime();
  const activeBrowserProfileId = useTerminalPreviewStore(
    (state) => state.activeBrowserProfileId,
  );
  const browserActivationRevision = useTerminalPreviewStore(
    (state) => state.browserActivationRevision,
  );
  const browserActivationProjectId = useTerminalPreviewStore(
    (state) => state.browserActivationProjectId,
  );
  const activateBrowser = useTerminalPreviewStore(
    (state) => state.activateBrowser,
  );
  const { activeTool, onSetActiveTool, showAgentTeamTool } = tools;
  const { expanded, onClose, onStartResize, onToggleExpanded, panelWidth } =
    layout;
  const { activeProject, mode, onSetMode } = navigation;
  const { changesLoading, copy, fileLoading, onRefresh, save } = actions;
  const {
    changesViewMode,
    fileKind,
    markdownViewMode,
    selectedChangePath,
    selectedPath,
    svgViewMode,
    onSetChanges,
    onSetMarkdown,
    onSetSvg,
  } = view;
  const saveLoading = save.loading;
  const saveDisabled = save.disabled;
  const saveStatus: SaveStatus = save.status;
  const canSave = save.available;
  const pathCopied = copy.copied;
  const [automationConnectionCount, setAutomationConnectionCount] = useState(0);
  useEffect(() => {
    if (window.electronAPI?.isElectron !== true) {
      return;
    }
    void window.electronAPI
      .terminalBrowserAutomationGetSnapshot?.()
      .then((snapshot) =>
        setAutomationConnectionCount(snapshot.connections.length),
      );
    return window.electronAPI.onTerminalBrowserAutomationStateChanged?.(
      (snapshot) => setAutomationConnectionCount(snapshot.connections.length),
    );
  }, []);
  const availableTools: Array<
    | { kind: TerminalSidecarTool; label: string }
    | {
        kind: "browser-profile";
        profileId: TerminalBrowserProfileId;
        label: string;
      }
  > = [
    { kind: "preview", label: "Preview" },
    ...(window.electronAPI?.isElectron === true
      ? [
          {
            kind: "automation" as const,
            label:
              automationConnectionCount > 0
                ? `Automation · ${automationConnectionCount}`
                : "Automation",
          },
        ]
      : []),
    ...TERMINAL_BROWSER_PROFILE_IDS.map((profileId, index) => ({
      kind: "browser-profile" as const,
      profileId,
      label: `Browser ${index + 1}`,
    })),
    ...(showAgentTeamTool
      ? [{ kind: "agent-team" as const, label: "Agent Team" }]
      : []),
    { kind: "race", label: "Race" },
  ];
  const saveStatusLabel =
    saveStatus === "conflict"
      ? "Conflict"
      : saveStatus === "saving"
        ? "Saving..."
        : saveStatus === "unsaved"
          ? "Unsaved"
          : saveStatus === "saved"
            ? "Saved"
            : saveStatus === "editable"
              ? "Saved"
              : "Read only";

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 border-l border-slate-800 bg-slate-950"
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-label="Resize sidecar"
        aria-orientation="vertical"
        className={[
          "absolute left-0 top-0 z-20 h-full w-1.5 touch-none transition-colors",
          expanded
            ? ""
            : "cursor-col-resize bg-transparent hover:bg-slate-700/70",
        ].join(" ")}
        onPointerDown={onStartResize}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-slate-800 px-2 py-1.5">
          <div className="flex min-h-[34px] items-center gap-2">
            <div className="min-w-0 flex-1">
              <div
                className="flex max-w-full overflow-x-auto rounded-md border border-slate-800 bg-slate-900/70 p-0.5"
                role="tablist"
                aria-label="Sidecar tools"
              >
                {availableTools.map((tool) => {
                  const selected =
                    tool.kind === "browser-profile"
                      ? activeTool === "browser" &&
                        activeBrowserProfileId === tool.profileId
                      : activeTool === tool.kind;
                  return (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      data-testid={
                        tool.kind === "browser-profile"
                          ? `terminal-browser-profile-${tool.profileId}`
                          : `terminal-sidecar-${tool.kind}`
                      }
                      key={
                        tool.kind === "browser-profile"
                          ? tool.profileId
                          : tool.kind
                      }
                      className={[
                        "h-6 shrink-0 rounded-sm px-2 text-xs",
                        selected
                          ? "bg-slate-700 text-slate-50"
                          : "text-slate-400 hover:text-slate-100",
                      ].join(" ")}
                      onClick={() => {
                        if (tool.kind === "browser-profile") {
                          activateBrowser(
                            tool.profileId,
                            activeProject?.projectId ?? null,
                          );
                        } else {
                          onSetActiveTool(tool.kind);
                        }
                      }}
                    >
                      {tool.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 rounded-md px-0"
                onClick={onToggleExpanded}
                aria-label={
                  activeTool === "preview"
                    ? expanded
                      ? "Restore preview"
                      : "Expand preview"
                    : expanded
                      ? "Restore sidecar"
                      : "Expand sidecar"
                }
              >
                {expanded ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
              {activeTool === "preview" && canSave ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={[
                    "h-7 w-7 rounded-md px-0",
                    saveStatus === "unsaved" ? "text-amber-300" : "",
                  ].join(" ")}
                  disabled={saveDisabled || saveLoading}
                  onClick={save.run}
                  aria-label="Save preview file"
                >
                  <Save className="h-4 w-4" />
                </Button>
              ) : null}
              {activeTool === "preview" ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 rounded-md px-0"
                    disabled={!mode || fileLoading || changesLoading}
                    onClick={onRefresh}
                    aria-label="Refresh preview"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 rounded-md px-0"
                    disabled={!selectedPath}
                    onClick={copy.run}
                    aria-label={pathCopied ? "Path copied" : "Copy path"}
                    title={pathCopied ? "Path copied" : "Copy path"}
                  >
                    {pathCopied ? (
                      <Check className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 rounded-md px-0"
                onClick={onClose}
                aria-label="Close sidecar"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </header>
        {activeTool === "preview" ? (
          <div className="flex min-h-[34px] items-center gap-2 border-b border-slate-800 px-2 py-1">
            <div
              className="inline-flex shrink-0 rounded-md border border-slate-800 bg-slate-900/70 p-0.5"
              role="tablist"
              aria-label="Preview tasks"
            >
              {(["changes", "explorer", "file"] as const).map((previewMode) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === previewMode}
                  key={previewMode}
                  className={[
                    "h-6 rounded-sm px-2 text-xs",
                    mode === previewMode
                      ? "bg-slate-700 text-slate-50"
                      : "text-slate-400 hover:text-slate-100",
                  ].join(" ")}
                  onClick={() => onSetMode(previewMode)}
                >
                  {describeMode(previewMode)}
                </button>
              ))}
            </div>
            <p
              className="min-w-0 flex-1 truncate text-[11px] text-slate-500"
              title={activeProject?.path ?? activeProject?.name ?? undefined}
            >
              {activeProject?.name ?? "No project"}
            </p>
            <span
              className={[
                "shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase",
                saveStatus === "conflict"
                  ? "border-rose-700 text-rose-300"
                  : saveStatus === "unsaved"
                    ? "border-amber-700 text-amber-300"
                    : "border-slate-700 text-slate-400",
              ].join(" ")}
            >
              {saveStatusLabel}
            </span>
          </div>
        ) : null}
        {activeTool === "preview" && selectedPath ? (
          <div className="flex items-center gap-2 border-b border-slate-800 px-2 py-1.5 text-[11px] text-slate-400">
            <span className="min-w-0 flex-1 truncate">{selectedPath}</span>
            {(mode === "file" || mode === "explorer") &&
            fileKind === "markdown" ? (
              <div className="flex shrink-0 rounded-md border border-slate-800 p-0.5">
                {(["source", "split", "preview"] as const).map((viewMode) => (
                  <button
                    type="button"
                    key={viewMode}
                    className={[
                      "rounded-sm px-2 py-0.5 capitalize",
                      markdownViewMode === viewMode
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => onSetMarkdown(viewMode)}
                  >
                    {viewMode}
                  </button>
                ))}
              </div>
            ) : null}
            {(mode === "file" || mode === "explorer") && fileKind === "svg" ? (
              <div className="flex shrink-0 rounded-md border border-slate-800 p-0.5">
                {(["preview", "source"] as const).map((viewMode) => (
                  <button
                    type="button"
                    key={viewMode}
                    className={[
                      "rounded-sm px-2 py-0.5 capitalize",
                      svgViewMode === viewMode
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => onSetSvg(viewMode)}
                  >
                    {viewMode}
                  </button>
                ))}
              </div>
            ) : null}
            {mode === "changes" &&
            selectedChangePath &&
            (fileKind === "markdown" || fileKind === "svg") ? (
              <div className="flex shrink-0 rounded-md border border-slate-800 p-0.5">
                {(["diff", "preview"] as const).map((viewMode) => (
                  <button
                    type="button"
                    key={viewMode}
                    className={[
                      "rounded-sm px-2 py-0.5 capitalize",
                      changesViewMode === viewMode
                        ? "bg-slate-800 text-slate-100"
                        : "text-slate-400 hover:text-slate-200",
                    ].join(" ")}
                    onClick={() => onSetChanges(viewMode)}
                  >
                    {viewMode}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="relative min-h-0 flex-1">
          <div
            className={[
              "absolute inset-0 min-h-0",
              activeTool === "automation" ? "" : "pointer-events-none hidden",
            ].join(" ")}
          >
            {automationBody}
          </div>
          <div
            className={[
              "absolute inset-0 min-h-0",
              activeTool === "preview" ? "" : "pointer-events-none hidden",
            ].join(" ")}
          >
            {body}
          </div>
          <div
            className={[
              "absolute inset-0 min-h-0",
              activeTool === "browser" ? "" : "pointer-events-none hidden",
            ].join(" ")}
          >
            <TerminalBrowserTool
              active={activeTool === "browser"}
              apiBase={apiBase}
              profileId={activeBrowserProfileId}
              activationProjectId={browserActivationProjectId}
              activationRevision={browserActivationRevision}
              currentProjectId={activeProject?.projectId ?? null}
              token={token}
              terminalSessionId={activeTerminalSessionId}
            />
          </div>
          <div
            className={[
              "absolute inset-0 min-h-0",
              showAgentTeamTool && activeTool === "agent-team"
                ? ""
                : "pointer-events-none hidden",
            ].join(" ")}
          >
            {showAgentTeamTool && activeTool === "agent-team"
              ? agentTeamBody
              : null}
          </div>
          <div
            className={[
              "absolute inset-0 min-h-0",
              activeTool === "race" ? "" : "pointer-events-none hidden",
            ].join(" ")}
          >
            {raceBody}
          </div>
        </div>
      </div>
    </aside>
  );
}
