import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { Link } from "react-router-dom";
import { Feather } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SuijiClient } from "../../services/suiji";
import { SuijiDraftStore } from "./drafts";
import { SuijiWorkspace } from "./workspace";
import type { SuijiConnection } from "./connection-model";

export default function SuijiPage() {
  const [endpoint, setEndpoint] = useState(
    () => localStorage.getItem("suiji.endpoint.v1") ?? "http://127.0.0.1:4783",
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [connection, setConnection] = useState<SuijiConnection>();
  const current = useRef<SuijiClient | undefined>(undefined);
  const connect = useMemoizedFn(async (login: boolean) => {
    current.current?.cancel();
    setConnection(undefined);
    setBusy(true);
    setMessage("");
    let client: SuijiClient | undefined;
    try {
      client = new SuijiClient(endpoint);
      current.current = client;
      localStorage.setItem("suiji.endpoint.v1", client.endpoint);
      setEndpoint(client.endpoint);
      const info = login
        ? await client.login(username, password)
        : await client.info();
      if (current.current !== client || !client.active) return;
      setPassword("");
      setConnection({
        client,
        info,
        store: new SuijiDraftStore(client.endpoint, info),
      });
    } catch (error) {
      if (!client || (current.current === client && client.active))
        setMessage(error instanceof Error ? error.message : "连接失败");
    } finally {
      if (!client || current.current === client) setBusy(false);
    }
  });
  useEffect(() => {
    void connect(false);
    return () => {
      current.current?.cancel();
    };
  }, [connect]);
  const logout = useMemoizedFn(async () => {
    const old = current.current;
    current.current = undefined;
    old?.cancel();
    setConnection(undefined);
    setMessage("");
    setPassword("");
    try {
      await old?.logout();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退出失败");
    }
  });
  if (connection)
    return (
      <SuijiWorkspace
        key={connection.store.scope}
        connection={connection}
        onLogout={() => void logout()}
      />
    );
  return (
    <main className="suiji-theme flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="flex w-full max-w-md flex-col gap-7 rounded-3xl border bg-card p-8 shadow-sm">
        <div className="flex flex-col gap-3">
          <Feather className="size-9 text-primary" />
          <h1 className="text-3xl font-semibold">随记</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            留住当下的想法，慢慢再看。
            <br />
            连接你的随记服务，在电脑和手机间继续记录。
          </p>
        </div>
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void connect(true);
          }}
        >
          <label className="flex flex-col gap-2 text-sm">
            服务地址
            <Input
              aria-label="随记服务地址"
              type="url"
              required
              value={endpoint}
              disabled={busy}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            账号
            <Input
              aria-label="随记账号"
              autoComplete="username"
              required
              value={username}
              disabled={busy}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-2 text-sm">
            密码
            <Input
              aria-label="随记密码"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {message ? (
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          ) : null}
          <Button disabled={busy} type="submit">
            {busy ? "正在连接…" : "登录随记"}
          </Button>
          <Button
            disabled={busy}
            type="button"
            variant="outline"
            onClick={() => void connect(false)}
          >
            恢复本标签页登录
          </Button>
        </form>
        <Link
          to="/home"
          className="text-center text-sm text-muted-foreground underline underline-offset-4"
        >
          返回 Runweave
        </Link>
      </section>
    </main>
  );
}
