import type { SettingsPageProps } from "../features/settings/types";
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft, LogOut } from "lucide-react";
import { useLocation, useNavigate, type Location } from "react-router-dom";
import { Dialog, DialogSurface, DialogTitle } from "../components/ui/dialog";
import { useOverlayRef } from "../features/overlay/use-overlay-ref";
import {
  settingsPages,
  appNavigationItems,
  settingsPage,
  type SettingsPageId,
} from "../features/settings/registry";
import {
  settingsBackground,
  useSettingsNavigation,
} from "../features/settings/navigation";
import {
  SettingsTargetProvider,
  useSettingsTarget,
} from "../features/settings/target-context";
import { SettingsAuthGate } from "../features/settings/auth-gate";
import { RuntimeStatusProvider } from "../features/runtime-status/provider";
import { ResourceMonitorProvider } from "../features/system-monitor/resource-monitor-provider";
import {
  ConnectionQueryProvider,
  buildConnectionQueryScope,
} from "../features/query/connection-query-provider";
import type { ConnectionConfig } from "../features/connection/types";
import { useManagementExit, useSettingsCanLeave } from "../features/settings/edit-session";
import "../features/settings/settings.css";
const pages = {
  appearance: lazy(() => import("../features/settings/pages/appearance")),
  notifications: lazy(() => import("../features/settings/pages/notifications")),
  shortcuts: lazy(() => import("../features/settings/pages/shortcuts")),
  suiji: lazy(() => import("../features/settings/pages/suiji")),
  access: lazy(() => import("../features/settings/pages/access")),
  monitoring: lazy(() => import("../features/settings/pages/monitoring")),
  advanced: lazy(() => import("../features/settings/pages/advanced")),
  status: lazy(() => import("../features/settings/pages/status")),
  desktop: lazy(() => import("../features/settings/pages/desktop")),
};
const Connections = lazy(
  () => import("../features/settings/pages/connections"),
);
function ComputerContent({
  pageId,
  connections,
}: {
  pageId: Exclude<SettingsPageId, "connections">;
  connections: ConnectionConfig[];
}) {
  const t = useSettingsTarget(),
    Page = pages[pageId];
  const scope = buildConnectionQueryScope({
    apiBase: t.apiBase,
    connectionId: t.connectionId,
    generation: t.generation,
  });
  return (
    <SettingsAuthGate>
      <RuntimeStatusProvider
        apiBase={t.apiBase}
        token={t.auth.token}
        connections={connections}
        isElectron={window.electronAPI?.isElectron === true}
      >
        <ConnectionQueryProvider
          scope={scope}
          onUnauthorized={t.auth.clearToken}
        >
          <ResourceMonitorProvider
            key={`${scope}:${t.auth.sessionId}`}
            apiBase={t.apiBase}
            token={t.auth.token}
            connectionId={t.connectionId ?? scope}
            notifications={false}
          >
            <Page />
          </ResourceMonitorProvider>
        </ConnectionQueryProvider>
      </RuntimeStatusProvider>
    </SettingsAuthGate>
  );
}
export function SettingsPage(props: SettingsPageProps & { background: Location | null; pageContent?: ReactNode }) {
  const canLeave = useSettingsCanLeave();
  const managementExit = useManagementExit();
  const location = useLocation(),
    navigate = useNavigate(),
    openPage = useSettingsNavigation();
  const page = settingsPage(location.pathname.split("/")[2] ?? "appearance"),
    Page = page.id === "connections" ? null : pages[page.id];
  const external = props.pageContent !== undefined;
  const appPage = appNavigationItems.find(item => location.pathname === item.path || location.pathname.startsWith(item.path + "/"));
  const title = external ? appPage?.title ?? (location.pathname.startsWith("/background-runs") ? "后台运行" : location.pathname === "/login" ? "登录" : "连接管理") : page.title;
  const initialTarget = useRef(props.activeConnection?.id);
  const params = new URLSearchParams(location.search),
    targetId = params.get("target") ?? initialTarget.current;
  const target = props.connections.find(
    (connection) => connection.id === targetId,
  );
  const overlayRef = useOverlayRef<HTMLDivElement>(undefined, "window");
  const heading = useRef<HTMLHeadingElement>(null),
    content = useRef<HTMLElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    content.current?.scrollTo(0, 0);
  }, [title, location.search]);
  useEffect(() => {
    if (!external && location.pathname !== `/settings/${page.id}`)
      navigate(`/settings/${page.id}${location.search}`, {
        replace: true,
        state: location.state,
      });
  }, [external, location.pathname, location.search, location.state, navigate, page.id]);
  const back = () => {
    const background = props.background ?? settingsBackground(location);
    navigate(
      background
        ? background.pathname + background.search + background.hash
        : "/terminal",
      { state: background?.state },
    );
  };
  return (
    <SettingsTargetProvider
      connection={target}
      activeConnection={props.activeConnection}
      workspaceAuth={props.workspaceAuth}
      webApiBase={props.webApiBase}
    >
      <Dialog open>
        <DialogSurface
          aria-describedby={undefined}
          ref={overlayRef}
          className="settings-screen"
          role="dialog"
          aria-modal="true"
          onEscapeKeyDown={event => event.preventDefault()}
          onInteractOutside={event => event.preventDefault()}
        >
          <aside className="settings-sidebar">
            <button className="settings-back" title={managementExit?.preparedLabel ?? "返回当前终端"} onClick={() => managementExit?.exit(back)}>
              <ArrowLeft className="size-4" />
              返回终端
            </button>
            {managementExit?.preparedLabel && <p role="status" className="px-2 text-xs text-primary">已准备会话，从上方返回终端</p>}
            <nav aria-label="应用导航" className="mt-2 shrink-0 border-b pb-2">
              <p className="px-2 py-1 text-xs text-muted-foreground">应用导航</p>
              {appNavigationItems.map((item) => (
                <button
                  key={item.path}
                  aria-current={appPage?.path === item.path ? "page" : undefined}
                  className={`settings-nav ${appPage?.path === item.path ? "active" : ""}`}
                  onClick={() => navigate(item.path, { state: { settingsBackground: props.background } })}
                >
                  <item.icon className="size-4" />
                  {item.title}
                </button>
              ))}
            </nav>
            <h2 className="px-2 pb-1 pt-2 text-sm font-semibold">全局设置</h2>
            <nav aria-label="设置分类" className="shrink-0">
              {["本台应用", "连接与服务", "所选电脑", "状态与诊断"].map(
                (group) => (
                  <div key={group} className="mb-1">
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      {group}
                    </p>
                    {group === "所选电脑" && window.electronAPI?.isElectron && (
                      <select
                        aria-label="所选电脑"
                        className="mb-1 h-7 w-full rounded-md border bg-background px-2 text-xs"
                        value={target?.id ?? ""}
                        onChange={(event) => {
                          const next = new URLSearchParams(location.search);
                          next.set("target", event.target.value);
                          navigate(`${location.pathname}?${next}`, {
                            state: location.state,
                          });
                        }}
                      >
                        {!target && <option value="">请选择电脑</option>}
                        {props.connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {settingsPages
                      .filter((item) => item.group === group)
                      .map((item) => (
                        <button
                          key={item.id}
                          aria-current={
                            !external && item.id === page.id ? "page" : undefined
                          }
                          className={`settings-nav ${!external && item.id === page.id ? "active" : ""}`}
                          onClick={() => openPage(item.id)}
                        >
                          <item.icon className="size-4" />
                          {item.title}
                        </button>
                      ))}
                  </div>
                ),
              )}
            </nav>
            <div className="mt-auto shrink-0 border-t pt-2">
              <button
                className="settings-nav text-rose-600 dark:text-rose-400 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!canLeave}
                title={
                  canLeave
                    ? "退出工作区当前连接的登录"
                    : "请先保存修改或返回工作区放弃修改，并等待当前操作完成"
                }
                onClick={() => {
                  if (!canLeave) return;
                  props.workspaceAuth.clearToken();
                  navigate("/login");
                }}
              >
                <LogOut className="size-4" />
                退出登录
              </button>
              <p className="px-2 py-1 text-xs text-muted-foreground">
                工作区 · {props.activeConnection?.name ?? "当前电脑"}
              </p>
            </div>
          </aside>
          <main ref={content} className="settings-content">
            <div className={`settings-wrap ${external ? "management-wrap" : ""}`}>
              <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <DialogTitle asChild>
                  <h1
                    ref={heading}
                    tabIndex={-1}
                    className="text-xl font-semibold outline-none"
                  >
                    {title}
                  </h1>
                </DialogTitle>
                <span className="rounded border px-2 py-1 text-xs text-muted-foreground">
                  {external ? `当前连接 · ${props.activeConnection?.name ?? "当前电脑"}` : page.scope === "computer"
                    ? `所选电脑 · ${target?.name ?? "当前电脑"}`
                    : page.scope === "account"
                      ? "随记账户"
                      : "本台应用"}
                </span>
              </header>
              <Suspense fallback={<p role="status">正在加载…</p>}>
                {external ? <div className="management-content">{props.pageContent}</div> : page.scope === "computer" ? (
                  <ComputerContent
                    key={`${target?.id}:${target?.url}:${target?.generation}:${props.workspaceAuth.sessionId}`}
                    pageId={page.id}
                    connections={props.connections}
                  />
                ) : page.id === "connections" ? (
                  <Connections {...props} />
                ) : Page ? (
                  <Page />
                ) : null}
              </Suspense>
            </div>
          </main>
        </DialogSurface>
      </Dialog>
    </SettingsTargetProvider>
  );
}
