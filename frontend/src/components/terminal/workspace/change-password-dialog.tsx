import { useMemoizedFn } from "ahooks";
import { useState, type FormEvent } from "react";
import { useTerminalRuntime } from "../../../features/terminal/queries/provider";
import { changePassword } from "../../../services/auth";
import { HttpError } from "../../../services/http";
import { Button } from "../../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";

export function ChangePasswordDialog({ onClose }: { onClose: () => void }) {
  const { apiBase, token, onAuthExpired } = useTerminalRuntime();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useMemoizedFn(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      await changePassword(apiBase, token, { oldPassword, newPassword });
      onAuthExpired?.();
    } catch (changeError) {
      if (changeError instanceof HttpError && changeError.status === 401) {
        onAuthExpired?.();
      } else if (changeError instanceof HttpError && changeError.status === 403) {
        setError("Incorrect current password.");
      } else {
        setError(String(changeError));
      }
    } finally {
      setLoading(false);
    }
  });

  return (
    <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen && !loading) onClose(); }}>
      <DialogContent className="dark w-[calc(100vw-2rem)] border-slate-800 bg-slate-950 text-slate-100">
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>修改成功后需要重新登录。</DialogDescription>
        </DialogHeader>
        <form className="mt-2 space-y-4" onSubmit={(event) => void submit(event)}>
          <label className="block space-y-2 text-sm">
            <span>Current Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
              className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 outline-none focus:border-sky-500"
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>New Password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 outline-none focus:border-sky-500"
            />
          </label>
          {error ? <p role="alert" className="text-sm text-rose-400">{error}</p> : null}
          <Button type="submit" disabled={loading} className="w-full">
            {loading ? "Updating..." : "Update Password"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
