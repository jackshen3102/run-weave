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
import type {
  PreviewChangeResetTarget,
  PreviewFileMutationTarget,
} from "./use-terminal-preview-file-mutations";

interface RenameDialogProps {
  error: string | null;
  path: string;
  pending: boolean;
  target: PreviewFileMutationTarget | null;
  onClearError: () => void;
  onClose: () => void;
  onPathChange: (path: string) => void;
  onSubmit: () => void;
}

export function TerminalPreviewRenameDialog({
  error,
  path,
  pending,
  target,
  onClearError,
  onClose,
  onPathChange,
  onSubmit,
}: RenameDialogProps) {
  if (!target) {
    return null;
  }
  return (
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
              {target.path}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full px-3 text-slate-300"
            disabled={pending}
            onClick={onClose}
          >
            Close
          </Button>
        </div>
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
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
              value={path}
              onChange={(event) => {
                onPathChange(event.target.value);
                onClearError();
              }}
              className="h-12 w-full rounded-[1.25rem] border border-slate-800 bg-slate-900/80 px-4 text-sm text-slate-100 outline-none transition focus:border-slate-500"
              autoFocus
            />
          </div>
          {error ? (
            <p className="text-sm text-rose-400" role="alert">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            className="h-12 w-full rounded-full text-sm"
            disabled={pending}
          >
            {pending ? "Renaming..." : "Rename File"}
          </Button>
        </form>
      </section>
    </div>
  );
}

interface DeleteDialogProps {
  error: string | null;
  pending: boolean;
  target: PreviewFileMutationTarget | null;
  onClose: () => void;
  onSubmit: () => void;
}

export function TerminalPreviewDeleteDialog({
  error,
  pending,
  target,
  onClose,
  onSubmit,
}: DeleteDialogProps) {
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent className="w-[calc(100vw-2rem)] overflow-hidden">
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>Delete File</AlertDialogTitle>
          <AlertDialogDescription>
            This deletes the file from disk. This cannot be undone.
          </AlertDialogDescription>
          {target ? (
            <p className="min-w-0 break-all text-sm leading-6 text-slate-300">
              {target.path}
            </p>
          ) : null}
        </AlertDialogHeader>
        {error && target ? (
          <p className="text-sm text-rose-400" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className="bg-rose-600 text-white hover:bg-rose-500"
            onClick={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            {pending ? "Deleting..." : "Delete File"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ResetDialogProps {
  error: string | null;
  pending: boolean;
  target: PreviewChangeResetTarget | null;
  onClose: () => void;
  onSubmit: () => void;
}

export function TerminalPreviewResetDialog({
  error,
  pending,
  target,
  onClose,
  onSubmit,
}: ResetDialogProps) {
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <AlertDialogContent className="w-[calc(100vw-2rem)] overflow-hidden">
        <AlertDialogHeader className="min-w-0">
          <AlertDialogTitle>Reset Changes</AlertDialogTitle>
          <AlertDialogDescription>
            {target?.kind === "staged"
              ? "This unstages this file and keeps its working copy changes."
              : "This discards this file's working tree changes. This cannot be undone."}
          </AlertDialogDescription>
          {target ? (
            <p className="min-w-0 break-all text-sm leading-6 text-slate-300">
              {target.path}
            </p>
          ) : null}
        </AlertDialogHeader>
        {error && target ? (
          <p className="text-sm text-rose-400" role="alert">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className="bg-amber-600 text-white hover:bg-amber-500"
            onClick={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            {pending ? "Resetting..." : "Reset Changes"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
