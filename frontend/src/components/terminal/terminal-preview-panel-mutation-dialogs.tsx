import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

interface PreviewFileMutationTarget {
  path: string;
  expectedMtimeMs?: number;
}

interface TerminalPreviewPanelMutationDialogsProps {
  deleteTarget: PreviewFileMutationTarget | null;
  renameTarget: PreviewFileMutationTarget | null;
  renamePath: string;
  mutationPending: "delete" | "rename" | null;
  mutationError: string | null;
  onRenamePathChange: (path: string) => void;
  onClearMutationError: () => void;
  onCloseRename: () => void;
  onCloseDelete: () => void;
  onSubmitRename: () => void;
  onSubmitDelete: () => void;
}

export function TerminalPreviewPanelMutationDialogs({
  deleteTarget,
  renameTarget,
  renamePath,
  mutationPending,
  mutationError,
  onRenamePathChange,
  onClearMutationError,
  onCloseRename,
  onCloseDelete,
  onSubmitRename,
  onSubmitDelete,
}: TerminalPreviewPanelMutationDialogsProps) {
  return (
    <>
      {renameTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="preview-rename-title"
            className="w-full max-w-md rounded-[1.75rem] border border-slate-800/80 bg-slate-950 p-6 shadow-[0_34px_120px_-72px_rgba(15,23,42,0.92)]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  id="preview-rename-title"
                  className="text-lg font-semibold text-slate-100"
                >
                  Rename File
                </h2>
                <p className="mt-1 truncate text-sm text-slate-400">
                  {renameTarget.path}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full px-3 text-slate-300"
                disabled={mutationPending === "rename"}
                onClick={onCloseRename}
              >
                Close
              </Button>
            </div>
            <form
              className="mt-6 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmitRename();
              }}
            >
              <div className="space-y-2">
                <label
                  className="text-xs uppercase tracking-[0.24em] text-slate-500"
                  htmlFor="preview-rename-path"
                >
                  New file path
                </label>
                <input
                  id="preview-rename-path"
                  value={renamePath}
                  onChange={(event) => {
                    onRenamePathChange(event.target.value);
                    onClearMutationError();
                  }}
                  className="h-12 w-full rounded-[1.25rem] border border-slate-800 bg-slate-900/80 px-4 text-sm text-slate-100 outline-none transition focus:border-slate-500"
                  autoFocus
                />
              </div>
              {mutationError ? (
                <p className="text-sm text-rose-400" role="alert">
                  {mutationError}
                </p>
              ) : null}
              <Button
                type="submit"
                className="h-12 w-full rounded-full text-sm"
                disabled={mutationPending === "rename"}
              >
                {mutationPending === "rename" ? "Renaming..." : "Rename File"}
              </Button>
            </form>
          </section>
        </div>
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && mutationPending !== "delete") {
            onCloseDelete();
          }
        }}
      >
        <AlertDialogContent className="w-[calc(100vw-2rem)] overflow-hidden">
          <AlertDialogHeader className="min-w-0">
            <AlertDialogTitle>Delete File</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the file from disk. This cannot be undone.
            </AlertDialogDescription>
            {deleteTarget ? (
              <p className="min-w-0 break-all text-sm leading-6 text-slate-300">
                {deleteTarget.path}
              </p>
            ) : null}
          </AlertDialogHeader>
          {mutationError && deleteTarget ? (
            <p className="text-sm text-rose-400" role="alert">
              {mutationError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutationPending === "delete"}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={mutationPending === "delete"}
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={(event) => {
                event.preventDefault();
                onSubmitDelete();
              }}
            >
              {mutationPending === "delete" ? "Deleting..." : "Delete File"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
