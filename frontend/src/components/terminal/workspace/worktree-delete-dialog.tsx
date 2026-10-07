import type { TerminalProjectContextListItem } from "@runweave/shared/terminal/project-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../ui/alert-dialog";

export function WorktreeDeleteDialog({
  pendingDeletion,
  sessionCount,
  deleting,
  deleteError,
  onDismiss,
  onConfirm,
}: {
  pendingDeletion: TerminalProjectContextListItem | null;
  sessionCount: number;
  deleting: boolean;
  deleteError: string | null;
  onDismiss: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
      <AlertDialog
        open={pendingDeletion !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            onDismiss();
          }
        }}
      >
        <AlertDialogContent data-testid="terminal-worktree-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>删除 Worktree</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="block">
                将删除“{pendingDeletion?.name}”的工作目录，并关闭其中的
                {sessionCount}
                个 Terminal。
              </span>
              <span className="mt-2 block">
                分支 {pendingDeletion?.branch ?? "detached HEAD"} 会被保留。
              </span>
              <span className="mt-2 block">
                会尝试停止关联的 Dev Session；清理失败仍会继续删除。
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p
              role="alert"
              data-testid="terminal-worktree-delete-error"
              className="rounded-lg border border-rose-900/70 bg-rose-950/40 px-3 py-2 text-sm text-rose-300"
            >
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              data-testid="terminal-worktree-delete-confirm"
              className="bg-rose-500 text-white hover:bg-rose-500/90 hover:shadow-[0_22px_50px_-24px_rgba(244,63,94,0.82)]"
              onClick={(event) => {
                event.preventDefault();
                void onConfirm();
              }}
            >
              {deleting ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  );
}
