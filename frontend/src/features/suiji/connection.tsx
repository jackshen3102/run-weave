import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { ArrowLeft, Settings, X } from "lucide-react";
import type {
  SuijiDesktopState,
  SuijiEnvironment,
  SuijiProfile,
} from "@runweave/shared/suiji/desktop";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  SuijiClient,
  SuijiHttpError,
  suijiEndpoint,
} from "../../services/suiji";
import { SuijiDraftStore } from "./drafts";
import { SuijiWorkspace } from "./workspace";
import type { SuijiConnection } from "./connection-model";
import type { SuijiOpenLink } from "./browser-navigation";
import {
  environmentLabel,
  loadAccounts,
  saveProfile,
  selectEnvironment,
} from "./accounts";

export default function SuijiPage({
  active = true,
  onClose,
  onOpenLink,
}: {
  active?: boolean;
  onClose?: () => void;
  onOpenLink?: SuijiOpenLink;
}) {
  const [accounts, setAccounts] = useState<SuijiDesktopState>();
  const [endpoint, setEndpoint] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(true),
    [message, setMessage] = useState("");
  const [settings, setSettings] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(true);
  const [connection, setConnection] = useState<SuijiConnection>();
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(
    null,
  );
  const current = useRef<SuijiClient | undefined>(undefined);
  const alive = useRef(true);
  const generation = useRef(0);
  const openLink = useMemoizedFn((url: string) => {
    const sequence = generation.current;
    const client = current.current;
    onOpenLink?.(
      url,
      () =>
        alive.current &&
        generation.current === sequence &&
        current.current === client &&
        client !== undefined,
    );
  });
  const fill = (profile: SuijiProfile) => {
    setEndpoint(profile.endpoint);
    setUsername(profile.username);
    setPassword(profile.password ?? "");
  };
  const connect = useMemoizedFn(
    async (state: SuijiDesktopState, login = false) => {
      const sequence = ++generation.current;
      current.current?.cancel();
      setConnection(undefined);
      setBusy(true);
      setMessage("");
      const environment = state.active;
      let profile = { ...state.profiles[environment] };
      let client: SuijiClient | undefined;
      try {
        if (login)
          profile = {
            endpoint: suijiEndpoint(endpoint),
            username: username.trim(),
            password,
          };
        setNeedsLogin(login || (!profile.session && !profile.password));
        if (
          !profile.endpoint ||
          (!login && !profile.session && !profile.password)
        )
          return;
        client = new SuijiClient(profile.endpoint, {
          session: profile.session,
          credentials: profile.password
            ? { username: profile.username, password: profile.password }
            : undefined,
          persist: async (session, forget) => {
            if (!alive.current || sequence !== generation.current)
              throw new DOMException("连接已切换", "AbortError");
            const next = {
              ...profile,
              session,
              ...(forget ? { password: undefined } : {}),
            };
            await saveProfile(environment, next);
            profile = next;
            if (alive.current && sequence === generation.current)
              setAccounts((value) =>
                value
                  ? {
                      ...value,
                      profiles: { ...value.profiles, [environment]: next },
                    }
                  : value,
              );
          },
        });
        current.current = client;
        const info = login
          ? await client.login(profile.username, profile.password!)
          : await client.restore();
        if (!alive.current || sequence !== generation.current) return;
        setConnection({
          client,
          info,
          store: new SuijiDraftStore(client.endpoint, info, environment),
        });
        setSettings(false);
        fill(profile);
      } catch (error) {
        if (alive.current && sequence === generation.current) {
          if (error instanceof SuijiHttpError && error.status === 401) {
            setNeedsLogin(true);
            setPassword("");
          }
          setMessage(error instanceof Error ? error.message : "连接失败");
        }
      } finally {
        if (alive.current && sequence === generation.current) setBusy(false);
      }
    },
  );
  const initialize = useMemoizedFn(async () => {
    setBusy(true);
    setMessage("");
    try {
      const state = await loadAccounts();
      if (!alive.current) return;
      setAccounts(state);
      fill(state.profiles[state.active]);
      await connect(state);
    } catch (error) {
      if (alive.current) {
        setMessage(error instanceof Error ? error.message : "账户读取失败");
        setBusy(false);
      }
    }
  });
  const dispose = useMemoizedFn(() => {
    alive.current = false;
    ++generation.current;
    current.current?.cancel();
  });
  useEffect(() => {
    alive.current = true;
    void initialize();
    return dispose;
  }, [initialize, dispose]);
  const switchEnvironment = useMemoizedFn(
    async (environment: SuijiEnvironment) => {
      if (!accounts || busy || environment === accounts.active) return;
      setBusy(true);
      setMessage("");
      try {
        await selectEnvironment(environment);
        const state = await loadAccounts();
        setAccounts(state);
        fill(state.profiles[environment]);
        await connect(state);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "环境切换失败");
        setBusy(false);
      }
    },
  );
  const logout = useMemoizedFn(async () => {
    if (!accounts || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const old = current.current;
      if (old) await old.logout();
      else await saveProfile(accounts.active, { endpoint, username });
      ++generation.current;
      current.current = undefined;
      setConnection(undefined);
      setPassword("");
      setNeedsLogin(true);
      const state = await loadAccounts();
      setAccounts(state);
      fill(state.profiles[state.active]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "退出失败");
    } finally {
      setBusy(false);
    }
  });
  return (
    <section
      className="suiji-theme flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label="随记内容"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        {settings && connection ? (
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
      {connection ? (
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
      {settings || !connection ? (
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
                    onClick={() => {
                      current.current?.cancel();
                      ++generation.current;
                      setConnection(undefined);
                      setNeedsLogin(true);
                    }}
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
