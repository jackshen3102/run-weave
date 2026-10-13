import { useSettingsDraft } from "../../../features/settings/edit-session";
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
  return <ChangePasswordForm apiBase={apiBase} token={token} onAuthExpired={onAuthExpired} onClose={onClose} />;
}

export function ChangePasswordForm({ apiBase, token, onAuthExpired, onClose = () => {}, embedded = false }: { apiBase: string; token: string; onAuthExpired?: () => void; onClose?: () => void; embedded?: boolean }) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useMemoizedFn(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (loading) return;
    if (embedded && newPassword !== repeat) { setError("两次输入的新密码不一致。"); return; }
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

  useSettingsDraft(embedded && !!(oldPassword || newPassword || repeat), embedded && loading);
  const Surface = embedded ? "section" : DialogContent;
  const Title = embedded ? "h2" : DialogTitle;
  const Description = embedded ? "p" : DialogDescription;
  const content = (
      <Surface className={embedded ? "space-y-3 rounded-md border p-3" : "dark w-[calc(100vw-2rem)] border-slate-800 bg-slate-950 text-slate-100"}>
        <DialogHeader>
          <Title>修改密码</Title>
          <Description>修改成功后需要重新登录。</Description>
        </DialogHeader>
        <form className="mt-2 space-y-4" onSubmit={(event) => void submit(event)}>
          <label className="block space-y-2 text-sm">
            <span>{embedded ? "当前密码" : "Current Password"}</span>
            <input
              disabled={loading}
              type="password"
              autoComplete="current-password"
              value={oldPassword}
              onChange={(event) => setOldPassword(event.target.value)}
              className={embedded ? "h-10 w-full rounded-md border bg-background px-3 outline-none focus:border-primary" : "h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 outline-none focus:border-sky-500"}
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>{embedded ? "新密码" : "New Password"}</span>
            <input
              disabled={loading}
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className={embedded ? "h-10 w-full rounded-md border bg-background px-3 outline-none focus:border-primary" : "h-10 w-full rounded-md border border-slate-700 bg-slate-900 px-3 outline-none focus:border-sky-500"}
            />
          </label>
          {embedded && <label className="block space-y-2 text-sm"><span>确认新密码</span><input type="password" autoComplete="new-password" className="h-10 w-full rounded-md border bg-background px-3" disabled={loading} value={repeat} onChange={event => setRepeat(event.target.value)} /></label>}
          {error ? <p role="alert" className="text-sm text-rose-400">{error}</p> : null}
          <Button type="submit" disabled={loading} className="w-full">
            {embedded ? loading ? "修改中…" : "修改密码" : loading ? "Updating..." : "Update Password"}
          </Button>
        </form>
      </Surface>
  );
  return embedded ? content : <Dialog open onOpenChange={nextOpen => { if (!nextOpen && !loading) onClose(); }}>{content}</Dialog>;
}
