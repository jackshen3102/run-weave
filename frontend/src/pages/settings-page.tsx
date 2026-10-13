import type { SettingsPageProps } from "../features/settings/types";
import { lazy, Suspense, useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { Dialog, DialogSurface, DialogTitle } from "../components/ui/dialog";
import { useOverlayRef } from "../features/overlay/use-overlay-ref";
import {
  settingsPages,
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
export function SettingsPage(props: SettingsPageProps) {
  const location = useLocation(),
    navigate = useNavigate(),
    openPage = useSettingsNavigation();
  const page = settingsPage(location.pathname.split("/")[2] ?? "appearance"),
    Page = page.id === "connections" ? null : pages[page.id];
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
  }, [page.id, location.search]);
  useEffect(() => {
    if (location.pathname !== `/settings/${page.id}`)
      navigate(`/settings/${page.id}${location.search}`, {
        replace: true,
        state: location.state,
      });
  }, [location.pathname, location.search, location.state, navigate, page.id]);
  const back = () => {
    const background = settingsBackground(location);
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
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) back();
        }}
      >
        <DialogSurface
          aria-describedby={undefined}
          ref={overlayRef}
          className="settings-screen"
          role="dialog"
          aria-modal="true"
        >
          <aside className="settings-sidebar">
            <button className="settings-back" onClick={back}>
              <ArrowLeft className="size-4" />
              返回工作区
            </button>
            <h2 className="px-3 pb-4 pt-7 text-xl font-semibold">全局设置</h2>
            <nav aria-label="设置分类">
              {["本台应用", "连接与服务", "所选电脑", "状态与诊断"].map(
                (group) => (
                  <div key={group} className="mb-5">
                    <p className="px-3 py-2 text-xs text-muted-foreground">
                      {group}
                    </p>
                    {group === "所选电脑" && window.electronAPI?.isElectron && (
                      <select
                        aria-label="所选电脑"
                        className="mb-2 w-full rounded-lg border bg-background p-2 text-sm"
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
                            item.id === page.id ? "page" : undefined
                          }
                          className={`settings-nav ${item.id === page.id ? "active" : ""}`}
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
            <p className="mt-auto px-3 py-3 text-xs text-muted-foreground">
              Runweave Desktop
            </p>
          </aside>
          <main ref={content} className="settings-content">
            <div className="settings-wrap">
              <header className="mb-10 flex flex-wrap items-center justify-between gap-3">
                <DialogTitle asChild>
                  <h1
                    ref={heading}
                    tabIndex={-1}
                    className="text-3xl font-semibold outline-none"
                  >
                    {page.title}
                  </h1>
                </DialogTitle>
                <span className="rounded-md border px-3 py-1.5 text-xs text-muted-foreground">
                  {page.scope === "computer"
                    ? `所选电脑 · ${target?.name ?? "当前电脑"}`
                    : page.scope === "account"
                      ? "随记账户"
                      : "本台应用"}
                </span>
              </header>
              <Suspense fallback={<p role="status">正在加载…</p>}>
                {page.scope === "computer" ? (
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
