import type { ConnectionConfig } from "./types";
import { useConnectionWorkspaceOverview } from "./workspace-overview";
import { ConnectionSwitcher } from "../../components/connection-switcher";
import { Button } from "../../components/ui/button";

export function RemoteConnectionInterrupted({
  connection,
  connections,
  onSelectConnection,
  onOpenConnectionManager,
  onReconnect,
}: {
  connection: ConnectionConfig;
  connections: ConnectionConfig[];
  onSelectConnection: (connectionId: string) => void;
  onOpenConnectionManager: () => void;
  onReconnect: () => void;
}) {
  const overview = useConnectionWorkspaceOverview((state) => state.byConnectionId[connection.id]);
  const lastObserved = overview?.observedAt ? new Date(overview.observedAt).toLocaleString() : null;
  return <main className="flex min-h-screen flex-col gap-5 bg-slate-950 p-8 text-slate-100">
    <ConnectionSwitcher connections={connections} activeConnectionId={connection.id} onSelectConnection={onSelectConnection} onOpenConnectionManager={onOpenConnectionManager} />
    <section className="max-w-lg space-y-3 rounded-xl border border-slate-700 p-5">
      <h1 className="text-lg font-semibold">{connection.name} · {connection.remoteStatus === "connecting" || connection.remoteStatus === "reconnecting" ? "正在重连" : "连接不可用"}</h1>
      <p className="text-sm text-slate-300">{connection.statusMessage ?? "等待 SSH 通道，可在端口与隧道中连接主机"}</p>
      {lastObserved ? <p className="text-xs text-slate-400">上次终端状态更新：{lastObserved}。下方为历史信息，不代表终端仍在运行。</p> : null}
      {overview ? <p className="text-sm text-slate-300">已记录 {overview.projects.length} 个项目、{overview.sessions.length} 个终端。</p> : null}
      <div className="flex gap-2"><Button onClick={onReconnect}>打开端口与隧道</Button><Button variant="outline" onClick={onOpenConnectionManager}>连接管理</Button></div>
    </section>
  </main>;
}
