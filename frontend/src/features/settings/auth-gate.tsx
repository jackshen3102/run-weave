import { useState, type ReactNode } from "react";
import { useMemoizedFn } from "ahooks";
import { login } from "../../services/auth";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useSettingsTarget } from "./target-context";
import { useSettingsDraft } from "./edit-session";
export function SettingsAuthGate({ children }: { children: ReactNode }) {
  const { connection, connectionId, apiBase, auth } = useSettingsTarget();
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useSettingsDraft(Boolean(password), busy);
  const submit = useMemoizedFn(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      auth.setSession(
        await login(
          apiBase,
          { username, password },
          {
            clientType: window.electronAPI?.isElectron ? "electron" : "web",
            connectionId: connectionId ?? undefined,
          },
        ),
      );
      setPassword("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setBusy(false);
    }
  });
  if (
    window.electronAPI?.isElectron &&
    (!connection || connection.available === false)
  )
    return <p role="alert">所选电脑不可用，请在连接管理中恢复连接。</p>;
  if (auth.status === "checking") return <p role="status">正在核对登录状态…</p>;
  if (auth.token && auth.status === "authenticated") return children;
  return (
    <form
      className="max-w-md space-y-4 rounded-xl border p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2 className="font-medium">登录{connection?.name ?? "当前电脑"}</h2>
      <label className="grid gap-2 text-sm">
        账号
        <Input
          autoComplete="username"
          value={username}
          disabled={busy}
          onChange={(event) => setUsername(event.target.value)}
        />
      </label>
      <label className="grid gap-2 text-sm">
        密码
        <Input
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy}>{busy ? "登录中…" : "登录"}</Button>
    </form>
  );
}
