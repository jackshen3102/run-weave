export function WorktreeCleanupNotice({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-testid="terminal-worktree-cleanup-notice"
      className="m-2 rounded border border-amber-800/60 bg-amber-950/30 p-2 text-xs text-amber-200"
    >
      <p className="break-words">{message}</p>
      <button
        type="button"
        className="mt-2 text-amber-300 underline hover:text-amber-100"
        onClick={onDismiss}
      >
        关闭提示
      </button>
    </div>
  );
}
