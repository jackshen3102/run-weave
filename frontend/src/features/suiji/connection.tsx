import { useSettingsDraft } from "../settings/edit-session";
import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { ArrowLeft, Settings, X } from "lucide-react";
import type { SuijiEnvironment } from "@runweave/shared/suiji/desktop";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { SuijiWorkspace } from "./workspace";
import type { SuijiOpenLink } from "./browser-navigation";
import { environmentLabel } from "./accounts";
import { useSuijiConnection } from "./connection-provider";

export default function SuijiPage({
  active = true,
  accountOnly = false,
  onClose,
  onOpenLink,
}: {
  active?: boolean;
  accountOnly?: boolean;
  onClose?: () => void;
  onOpenLink?: SuijiOpenLink;
}) {
  const { accounts, endpoint, setEndpoint, username, setUsername, password, setPassword,
    busy, message, connection, needsLogin, setNeedsLogin, ensure, initialize, connect,
    switchEnvironment: changeEnvironment, logout, editAccount, isCurrent } = useSuijiConnection();
  const [settings, setSettings] = useState(accountOnly);
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; void ensure(); return () => { alive.current = false; }; }, [ensure]);
  useEffect(() => { if (connection) setSettings(accountOnly); }, [connection, accountOnly]);
  const openLink = useMemoizedFn((url: string) => {
    const client = connection?.client;
    onOpenLink?.(url, () => alive.current && !!client && isCurrent(client));
  });
  const switchEnvironment = useMemoizedFn(async (environment: SuijiEnvironment) => {
    if (dirty && !window.confirm("放弃当前环境未保存的账户修改？")) return;
    await changeEnvironment(environment);
  });
  const profile = accounts?.profiles[accounts.active];
  const dirty = accountOnly && !!profile && !connection && (endpoint !== profile.endpoint || username !== profile.username || password !== (profile.password ?? ""));
  useSettingsDraft(dirty, accountOnly && busy && dirty);
  return (
    <section
      className="suiji-theme flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label="随记内容"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        {settings && connection && !accountOnly ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="返回随记"
            onClick={() => setSettings(false)}
          >
            <ArrowLeft className="size-4" />
          </Button>
        ) : null}
        <h1 className="font-semibold">{settings ? "账户设置" : "随记"}</h1>
        {accounts?.active === "development" ? (
          <span className="rounded bg-secondary px-2 py-0.5 text-xs">开发</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {!settings ? <div ref={setHeaderActions} className="flex" /> : null}
          {connection && !settings ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="随记设置"
              onClick={() => setSettings(true)}
            >
              <Settings className="size-4" />
            </Button>
          ) : null}
          {onClose ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="关闭随记"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>
      </header>
      {connection && !accountOnly ? (
        <div hidden={settings} className="min-h-0 flex-1">
          <SuijiWorkspace
            key={connection.store.scope}
            connection={connection}
            active={active}
            headerActions={headerActions}
            onOpenLink={onOpenLink ? openLink : undefined}
          />
        </div>
      ) : null}
      {accountOnly || settings || !connection ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {accounts ? (
            <>
              <fieldset
                disabled={busy}
                className="mb-6 flex gap-2"
                aria-label="账户环境"
              >
                {(["production", "development"] as const).map((env) => (
                  <Button
                    key={env}
                    className="flex-1"
                    variant={accounts.active === env ? "default" : "outline"}
                    aria-pressed={accounts.active === env}
                    onClick={() => void switchEnvironment(env)}
                  >
                    {environmentLabel(env)}
                  </Button>
                ))}
              </fieldset>
              <p className="mb-5 text-sm text-muted-foreground">
                {connection
                  ? "切换环境会保留各自的账户和草稿。"
                  : "首次登录后，下次打开会自动连接。"}
              </p>
              {connection ? (
                <div className="flex flex-col gap-4 text-sm">
                  <p>
                    已登录{environmentLabel(accounts.active)}环境 · {username}
                  </p>
                  <p className="break-all text-muted-foreground">{endpoint}</p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={editAccount}
                  >
                    修改账户配置
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void logout()}
                  >
                    退出{environmentLabel(accounts.active)}账户
                  </Button>
                </div>
              ) : needsLogin ? (
                <form
                  className="flex flex-col gap-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void connect(accounts, true);
                  }}
                >
                  <label className="flex flex-col gap-2 text-sm">
                    服务地址
                    <Input
                      aria-label="随记服务地址"
                      type="url"
                      value={endpoint}
                      required
                      disabled={busy}
                      onChange={(event) => setEndpoint(event.target.value)}
                      placeholder="https://你的随记服务"
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm">
                    账号
                    <Input
                      aria-label="随记账号"
                      autoComplete="username"
                      value={username}
                      required
                      disabled={busy}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-2 text-sm">
                    密码
                    <Input
                      aria-label="随记密码"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      required
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                  <Button type="submit" disabled={busy}>
                    {busy ? "正在连接…" : "登录随记"}
                  </Button>
                </form>
              ) : (
                <div className="flex flex-col gap-4 text-sm">
                  <p>
                    {busy
                      ? "正在恢复已保存的账户…"
                      : "暂时无法连接，账户和草稿已保留。"}
                  </p>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setNeedsLogin(true)}
                  >
                    修改账户配置
                  </Button>
                </div>
              )}
            </>
          ) : null}
          {busy ? (
            <p role="status" className="mt-4 text-sm">
              正在连接…
            </p>
          ) : null}
          {message ? (
            <div className="mt-4 flex flex-col gap-3">
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void initialize()}
              >
                重试连接
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
