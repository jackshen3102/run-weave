import { useState } from "react";
import { Button } from "../../../components/ui/button";

interface ChangePasswordDialogProps {
  open: boolean;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: {
    oldPassword: string;
    newPassword: string;
  }) => Promise<void>;
}

export function ChangePasswordDialog({
  open,
  loading,
  error,
  onClose,
  onSubmit,
}: ChangePasswordDialogProps) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  if (!open) {
    return null;
  }

  const submit = async (): Promise<void> => {
    await onSubmit({
      oldPassword,
      newPassword,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4">
      <section className="w-full max-w-md rounded-[1.75rem] border border-border/60 bg-card p-6 shadow-[0_34px_120px_-72px_rgba(17,24,39,0.82)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Change Password</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Username is fixed as <span className="font-medium">admin</span>.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full px-3"
            onClick={onClose}
            disabled={loading}
          >
            Close
          </Button>
        </div>

        <div className="mt-6 space-y-4">
          <div className="space-y-2">
            <label
              className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70"
              htmlFor="current-password"
            >
              Current Password
            </label>
            <input
              id="current-password"
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
              className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50"
            />
          </div>

          <div className="space-y-2">
            <label
              className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70"
              htmlFor="new-password"
            >
              New Password
            </label>
            <input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50"
            />
          </div>

          {error ? (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          ) : null}

          <Button
            className="h-12 w-full rounded-full text-sm"
            disabled={loading}
            onClick={() => void submit()}
          >
            {loading ? "Updating..." : "Update Password"}
          </Button>
        </div>
      </section>
    </div>
  );
}
