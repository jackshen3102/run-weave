import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { Button } from "../../ui/button";

interface TerminalProjectDialogProps {
  open: boolean;
  mode: "create" | "edit";
  loading: boolean;
  error: string | null;
  canSelectDirectory: boolean;
  initialName?: string;
  initialPath?: string | null;
  onClose: () => void;
  onSubmit: (name: string, projectPath: string) => Promise<void>;
}

export function TerminalProjectDialog({
  open,
  mode,
  loading,
  error,
  canSelectDirectory,
  initialName = "",
  initialPath = "",
  onClose,
  onSubmit,
}: TerminalProjectDialogProps) {
  const [name, setName] = useState(initialName);
  const [projectPath, setProjectPath] = useState(initialPath ?? "");
  const [nameEdited, setNameEdited] = useState(mode === "edit");
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const selectionRequest = useRef(0);
  const selectDirectory =
    canSelectDirectory && window.electronAPI?.isElectron
      ? window.electronAPI.selectProjectDirectory
      : undefined;
  const busy = loading || selecting;

  useEffect(() => {
    if (!open) {
      return;
    }

    setName(initialName);
    setProjectPath(initialPath ?? "");
    setNameEdited(mode === "edit");
    setSelecting(false);
    setSelectionError(null);
    return () => {
      selectionRequest.current += 1;
    };
  }, [initialName, initialPath, mode, open]);

  const chooseDirectory = useMemoizedFn(async (): Promise<void> => {
    if (!selectDirectory || busy) return;
    const request = ++selectionRequest.current;
    setSelecting(true);
    setSelectionError(null);
    try {
      const selectedPath = await selectDirectory(projectPath);
      if (request !== selectionRequest.current || selectedPath === null) return;
      setProjectPath(selectedPath);
      if (!nameEdited || !name.trim()) {
        const separator =
          window.electronAPI?.platform === "win32" ? /[\\/]/ : "/";
        setName(
          selectedPath.split(separator).filter(Boolean).at(-1) ?? selectedPath,
        );
        setNameEdited(false);
      }
    } catch (error) {
      if (request === selectionRequest.current) {
        setSelectionError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (request === selectionRequest.current) setSelecting(false);
    }
  });

  if (!open) {
    return null;
  }

  const submit = async (): Promise<void> => {
    if (busy) return;
    setSelectionError(null);
    await onSubmit(name, projectPath);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
      <section className="w-full max-w-md rounded-[1.75rem] border border-slate-800/80 bg-slate-950 p-6 shadow-[0_34px_120px_-72px_rgba(15,23,42,0.92)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">
              {mode === "create" ? "Create Project" : "Edit Project"}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {mode === "create"
                ? "Create a project bucket above your terminal tabs."
                : "Update the name or project path for this terminal project."}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full px-3 text-slate-300"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </Button>
        </div>

        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <label
              className="text-xs uppercase tracking-[0.24em] text-slate-500"
              htmlFor="terminal-project-path"
            >
              Project Path
            </label>
            <div className="flex items-center gap-2">
              <input
                id="terminal-project-path"
                value={projectPath}
                placeholder="/path/to/project"
                disabled={busy}
                onChange={(event) => setProjectPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submit();
                  }
                }}
                className="h-12 min-w-0 flex-1 rounded-[1.25rem] border border-slate-800 bg-slate-900/80 px-4 text-sm text-slate-100 outline-none transition focus:border-slate-500"
              />
              {selectDirectory ? (
                <Button
                  variant="outline"
                  className="h-12 shrink-0 rounded-[1.25rem] px-3"
                  disabled={busy}
                  onClick={() => {
                    void chooseDirectory();
                  }}
                >
                  {selecting ? "Selecting..." : "Select Folder…"}
                </Button>
              ) : null}
            </div>
            <p className="text-xs text-slate-500">
              Optional. Preview uses this path as its file root.
            </p>
          </div>
          <div className="space-y-2">
            <label
              className="text-xs uppercase tracking-[0.24em] text-slate-500"
              htmlFor="terminal-project-name"
            >
              Project Name
            </label>
            <input
              id="terminal-project-name"
              value={name}
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
                setNameEdited(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="h-12 w-full rounded-[1.25rem] border border-slate-800 bg-slate-900/80 px-4 text-sm text-slate-100 outline-none transition focus:border-slate-500"
            />
          </div>

          {selectionError || error ? (
            <p className="text-sm text-rose-400" role="alert">
              {selectionError || error}
            </p>
          ) : null}

          <Button
            className="h-12 w-full rounded-full text-sm"
            disabled={busy}
            onClick={() => {
              void submit();
            }}
          >
            {loading
              ? mode === "create"
                ? "Creating..."
                : "Saving..."
              : mode === "create"
                ? "Create Project"
                : "Save Project"}
          </Button>
        </div>
      </section>
    </div>
  );
}
