import { type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Check,
  Copy,
  Maximize2,
  Minimize2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { Button } from "../ui/button";
import { TerminalBrowserTool } from "./terminal-browser-tool";

interface ActiveProjectLike {
  name?: string;
  path?: string | null;
}

type TerminalSidecarPanelTool = "preview" | "browser" | "orchestrator";

interface TerminalPreviewPanelShellProps {
  panelWidth: string;
  expanded: boolean;
  activeTool: TerminalSidecarPanelTool;
  mode: string | null;
  fileKind: string;
  fileLoading: boolean;
  changesLoading: boolean;
  saveLoading: boolean;
  saveDisabled: boolean;
  saveStatus:
    | "readonly"
    | "editable"
    | "unsaved"
    | "saving"
    | "saved"
    | "conflict";
  canSave: boolean;
  selectedPath: string | null;
  pathCopied: boolean;
  markdownViewMode: "source" | "split" | "preview";
  svgViewMode: "preview" | "source";
  changesViewMode: "diff" | "preview";
  selectedChangePath?: string;
  activeProject: ActiveProjectLike | null;
  body: ReactNode;
  orchestratorBody?: ReactNode;
  onStartResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSetActiveTool: (tool: TerminalSidecarPanelTool) => void;
  onSetPreviewMode: (mode: "changes" | "file" | "explorer") => void;
  onToggleExpanded: () => void;
  onRefresh: () => void;
  onSave: () => void;
  onCopyPath: () => void;
  onClosePreview: () => void;
  onSetMarkdownViewMode: (nextMode: "source" | "split" | "preview") => void;
  onSetSvgViewMode: (nextMode: "preview" | "source") => void;
  onSetChangesViewMode: (nextMode: "diff" | "preview") => void;
}

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
  panelWidth,
  expanded,
  activeTool,
  mode,
  fileKind,
  fileLoading,
  changesLoading,
  saveLoading,
  saveDisabled,
  saveStatus,
  canSave,
  selectedPath,
  pathCopied,
  markdownViewMode,
  svgViewMode,
  changesViewMode,
  selectedChangePath,
  activeProject,
  body,
  orchestratorBody,
  onStartResize,
  onSetActiveTool,
  onSetPreviewMode,
  onToggleExpanded,
  onRefresh,
  onSave,
  onCopyPath,
  onClosePreview,
  onSetMarkdownViewMode,
  onSetSvgViewMode,
  onSetChangesViewMode,
}: TerminalPreviewPanelShellProps) {
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
                className="inline-flex rounded-md border border-slate-800 bg-slate-900/70 p-0.5"
                role="tablist"
                aria-label="Sidecar tools"
              >
                {(["preview", "browser", "orchestrator"] as const).map((tool) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={activeTool === tool}
                    key={tool}
                    className={[
                      "h-6 rounded-sm px-2 text-xs",
                      activeTool === tool
                        ? "bg-slate-700 text-slate-50"
                        : "text-slate-400 hover:text-slate-100",
                    ].join(" ")}
                    onClick={() => onSetActiveTool(tool)}
                  >
                    {tool === "preview"
                      ? "Preview"
                      : tool === "browser"
                        ? "Browser"
                        : "Orchestrator"}
                  </button>
                ))}
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
              {canSave ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className={[
                    "h-7 w-7 rounded-md px-0",
                    saveStatus === "unsaved" ? "text-amber-300" : "",
                  ].join(" ")}
                  disabled={saveDisabled || saveLoading}
                  onClick={onSave}
                  aria-label="Save preview file"
                >
                  <Save className="h-4 w-4" />
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 rounded-md px-0"
                disabled={
                  activeTool !== "preview" ||
                  !mode ||
                  fileLoading ||
                  changesLoading
                }
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
                disabled={activeTool !== "preview" || !selectedPath}
                onClick={onCopyPath}
                aria-label={pathCopied ? "Path copied" : "Copy path"}
                title={pathCopied ? "Path copied" : "Copy path"}
              >
                {pathCopied ? (
                  <Check className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 rounded-md px-0"
                onClick={onClosePreview}
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
                  onClick={() => onSetPreviewMode(previewMode)}
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
            {(mode === "file" || mode === "explorer") && fileKind === "markdown" ? (
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
                    onClick={() => onSetMarkdownViewMode(viewMode)}
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
                    onClick={() => onSetSvgViewMode(viewMode)}
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
                    onClick={() => onSetChangesViewMode(viewMode)}
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
            <TerminalBrowserTool active={activeTool === "browser"} />
          </div>
          <div
            className={[
              "absolute inset-0 min-h-0",
              activeTool === "orchestrator" ? "" : "pointer-events-none hidden",
            ].join(" ")}
          >
            {activeTool === "orchestrator" ? orchestratorBody : null}
          </div>
        </div>
      </div>
    </aside>
  );
}
