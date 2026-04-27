import { type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Copy, Maximize2, Minimize2, RefreshCw, X } from "lucide-react";
import { Button } from "../ui/button";
import { TerminalBrowserTool } from "./terminal-browser-tool";

interface ActiveProjectLike {
  name?: string;
  path?: string | null;
}

interface TerminalPreviewPanelShellProps {
  panelWidth: string;
  expanded: boolean;
  activeTool: "preview" | "browser";
  mode: string | null;
  fileKind: string;
  fileLoading: boolean;
  changesLoading: boolean;
  selectedPath: string | null;
  markdownViewMode: "source" | "split" | "preview";
  svgViewMode: "preview" | "source";
  changesViewMode: "diff" | "preview";
  selectedChangePath?: string;
  activeProject: ActiveProjectLike | null;
  body: ReactNode;
  onStartResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSetActiveTool: (tool: "preview" | "browser") => void;
  onSetPreviewMode: (mode: "changes" | "file") => void;
  onToggleExpanded: () => void;
  onRefresh: () => void;
  onCopyPath: () => void;
  onClosePreview: () => void;
  onSetMarkdownViewMode: (nextMode: "source" | "split" | "preview") => void;
  onSetSvgViewMode: (nextMode: "preview" | "source") => void;
  onSetChangesViewMode: (nextMode: "diff" | "preview") => void;
}

function describeMode(mode: string | null | undefined): string {
  if (mode === "file") {
    return "Files";
  }
  if (mode === "changes") {
    return "Review changes";
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
  selectedPath,
  markdownViewMode,
  svgViewMode,
  changesViewMode,
  selectedChangePath,
  activeProject,
  body,
  onStartResize,
  onSetActiveTool,
  onSetPreviewMode,
  onToggleExpanded,
  onRefresh,
  onCopyPath,
  onClosePreview,
  onSetMarkdownViewMode,
  onSetSvgViewMode,
  onSetChangesViewMode,
}: TerminalPreviewPanelShellProps) {
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
          expanded ? "" : "cursor-col-resize bg-transparent hover:bg-slate-700/70",
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
                {(["preview", "browser"] as const).map((tool) => (
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
                    {tool === "preview" ? "Preview" : "Browser"}
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 w-7 rounded-md px-0"
                disabled={activeTool !== "preview" || !mode || fileLoading || changesLoading}
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
                aria-label="Copy path"
              >
                <Copy className="h-4 w-4" />
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
          <div className="border-b border-slate-800 px-2 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <div
                className="inline-flex shrink-0 rounded-md border border-slate-800 bg-slate-900/70 p-0.5"
                role="tablist"
                aria-label="Preview tasks"
              >
                {(["changes", "file"] as const).map((previewMode) => (
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
              <span className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[9px] uppercase text-slate-400">
                Read only
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-slate-500">
              {activeProject?.name ?? "No project"}
              {activeProject?.path ? ` · root: ${activeProject.path}` : ""}
            </p>
          </div>
        ) : null}
        {activeTool === "preview" && selectedPath ? (
          <div className="flex items-center gap-2 border-b border-slate-800 px-2 py-1.5 text-[11px] text-slate-400">
            <span className="min-w-0 flex-1 truncate">{selectedPath}</span>
            {mode === "file" && fileKind === "markdown" ? (
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
            {mode === "file" && fileKind === "svg" ? (
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
        </div>
      </div>
    </aside>
  );
}
