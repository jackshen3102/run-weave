import { useState } from "react";
import { Button } from "./ui/button";
import type { ConnectionConfig } from "../features/connection/types";
import { shouldShowReconnectAction } from "../features/connection/system-connection";
import { RuntimeStatusEntry } from "./runtime-status-entry";
import type { ManualRemotePortAccess } from "@runweave/shared/remote";
import { RemotePortForwarding } from "./remote-port-forwarding";
import { useConnectionWorkspaceOverview } from "../features/connection/workspace-overview";
import { useProjectBindings } from "../features/connection/project-bindings";
import { getConnectionAuth } from "../features/auth/storage";
import { createTerminalProject } from "../services/terminal/projects";

interface ConnectionPageProps {
  connections: ConnectionConfig[];
  activeId: string | null;
  onAdd: (name: string, url: string) => void;
  onAddRemote: (name: string, host: string, backendPort: number, browserProfileId: "profile-1" | "profile-2" | "profile-3" | null, approvedBrowserGroupId: string | null) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, patch: { name?: string; url?: string }) => void;
  onReconnect?: (id: string) => Promise<boolean>;
  onForwardPort?: (id: string, remotePort: number) => Promise<ManualRemotePortAccess>;
}

export function ConnectionPage({
  connections,
  activeId,
  onAdd,
  onAddRemote,
  onRemove,
  onSelect,
  onEdit,
  onReconnect,
  onForwardPort,
}: ConnectionPageProps) {
  const [showForm, setShowForm] = useState(connections.length === 0);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [connectionKind, setConnectionKind] = useState<"url" | "ssh">("url");
  const [sshHost, setSshHost] = useState("");
  const [sshBackendPort, setSshBackendPort] = useState("5001");
  const [browserProfileId, setBrowserProfileId] = useState<"profile-1" | "profile-2" | "profile-3" | null>(null);
  const [approvedBrowserGroupId, setApprovedBrowserGroupId] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [projectDirectory, setProjectDirectory] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState<Record<string, string>>({});
  const [projectBusy, setProjectBusy] = useState<string | null>(null);
  const overviews = useConnectionWorkspaceOverview((state) => state.byConnectionId);
  const bindings = useProjectBindings((state) => state.bindings);
  const bindProject = useProjectBindings((state) => state.add);
  const unbindProject = useProjectBindings((state) => state.remove);

  const testConnection = async (targetUrl: string): Promise<boolean> => {
    setTesting(true);
    setTestResult(null);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const res = await fetch(`${targetUrl.replace(/\/+$/, "")}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        setTestResult("connected");
        return true;
      }
      setTestResult("unreachable");
      return false;
    } catch {
      setTestResult("unreachable");
      return false;
    } finally {
      setTesting(false);
    }
  };

  const handleAdd = async () => {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();

    if (!trimmedName) {
      setError("请输入连接名称");
      return;
    }
    if (connectionKind === "ssh") {
      const port = Number(sshBackendPort);
      if (!/^[a-zA-Z0-9_.@-]{1,255}$/.test(sshHost.trim()) || !Number.isInteger(port) || port < 1 || port > 65535) {
        setError("请输入有效的 SSH 主机和 Backend 端口");
        return;
      }
      const groupId = approvedBrowserGroupId.trim();
      if (groupId.length > 512) { setError("Browser 工作组 ID 不能超过 512 个字符"); return; }
      setError(null);
      onAddRemote(trimmedName, sshHost.trim(), port, browserProfileId, groupId || null);
      setName("");
      setSshHost("");
      setApprovedBrowserGroupId("");
      setShowForm(false);
      return;
    }
    if (!trimmedUrl) {
      setError("请输入后端地址");
      return;
    }

    setError(null);
    await testConnection(trimmedUrl);
    onAdd(trimmedName, trimmedUrl);
    setName("");
    setUrl("");
    setShowForm(false);
    setTestResult(null);
  };

  const handleEdit = (conn: ConnectionConfig) => {
    if (conn.canEdit === false) {
      return;
    }

    setEditingId(conn.id);
    setEditName(conn.name);
    setEditUrl(conn.url);
  };

  const handleEditSave = () => {
    if (!editingId) return;
    const trimmedName = editName.trim();
    const trimmedUrl = editUrl.trim();
    if (!trimmedName || !trimmedUrl) return;

    onEdit(editingId, { name: trimmedName, url: trimmedUrl });
    setEditingId(null);
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(70,130,145,0.18),transparent_30%),radial-gradient(circle_at_bottom_left,rgba(195,172,135,0.16),transparent_35%)]" />
      <section className="animate-fade-rise relative w-full max-w-lg rounded-[2rem] border border-border/60 bg-card/82 p-7 shadow-[0_34px_120px_-72px_rgba(17,24,39,0.82)] backdrop-blur-xl sm:p-9">
        <div className="flex items-center justify-between">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.38em] text-muted-foreground/70">
            连接管理
          </p>
          {connections.length > 0 && !showForm && (
            <Button
              size="sm"
              className="rounded-full px-4"
              onClick={() => {
                setShowForm(true);
                setError(null);
                setTestResult(null);
              }}
            >
              添加连接
            </Button>
          )}
        </div>
        <RuntimeStatusEntry className="mt-4 max-w-full" />

        {showForm && (
          <div className="mt-6 space-y-4">
            <div className="flex gap-2" role="group" aria-label="连接方式">
              <Button variant={connectionKind === "url" ? "default" : "outline"} onClick={() => setConnectionKind("url")}>后端地址</Button>
              <Button variant={connectionKind === "ssh" ? "default" : "outline"} onClick={() => setConnectionKind("ssh")}>SSH 服务器</Button>
            </div>
            {connectionKind === "ssh" ? (
              <div className="space-y-2 rounded-xl bg-muted/50 p-4 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">连接服务器 → 登录 Runweave → 添加项目</p>
                <p>使用本机已有的 SSH 配置，连接服务器上正在运行的 Runweave Backend。项目和终端命令在服务器上执行。</p>
              </div>
            ) : null}
            <div className="space-y-2">
              <label
                className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70"
                htmlFor="conn-name"
              >
                连接名称
              </label>
              <input
                id="conn-name"
                placeholder={connectionKind === "ssh" ? "例如：开发服务器" : "例如：本地开发"}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50"
              />
            </div>
            {connectionKind === "ssh" && <div className="space-y-2">
              <label className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70" htmlFor="ssh-host">SSH 主机或配置别名</label>
              <input id="ssh-host" placeholder="例如：user@example.com" value={sshHost} onChange={(event) => setSshHost(event.target.value)} className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50" />
              <p className="text-xs text-muted-foreground">也可填写 SSH 配置别名。请先在本机终端确认 SSH 可以连接；密钥和 SSH 端口沿用本机配置。</p>
              <label className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70" htmlFor="ssh-backend-port">远端 Backend 端口</label>
              <input id="ssh-backend-port" type="number" min="1" max="65535" value={sshBackendPort} onChange={(event) => setSshBackendPort(event.target.value)} className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50" />
              <p className="text-xs text-muted-foreground">填写服务器上 Runweave 的服务端口，默认 5001；不是 SSH 的 22 端口。</p>
              <details className="rounded-xl border border-border/60 p-3">
                <summary className="cursor-pointer text-sm text-muted-foreground">高级设置 · 本地 Browser</summary>
                <div className="mt-3 space-y-2">
                  <label className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70" htmlFor="ssh-browser-profile">本地 Browser 授权范围</label>
                  <select id="ssh-browser-profile" value={browserProfileId ?? "default"} onChange={(event) => setBrowserProfileId(event.target.value === "default" ? null : event.target.value as "profile-1" | "profile-2" | "profile-3")} className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50">
                    <option value="default">当前默认 Profile</option>
                    <option value="profile-1">Browser 1</option>
                    <option value="profile-2">Browser 2</option>
                    <option value="profile-3">Browser 3</option>
                  </select>
                  <label className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70" htmlFor="ssh-browser-group">允许复用的工作组 ID（可选）</label>
                  <input id="ssh-browser-group" value={approvedBrowserGroupId} onChange={(event) => setApprovedBrowserGroupId(event.target.value)} placeholder="只允许远端复用此本地工作组" className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50" />
                </div>
              </details>
            </div>}
            {connectionKind === "url" && <div className="space-y-2">
              <label
                className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70"
                htmlFor="conn-url"
              >
                后端地址
              </label>
              <input
                id="conn-url"
                placeholder="例如：http://192.168.1.100:5001"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleAdd();
                  }
                }}
                className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50"
              />
            </div>}

            {testResult === "connected" && (
              <p className="text-sm text-green-500">✓ 连接成功</p>
            )}
            {testResult === "unreachable" && (
              <p className="text-sm text-yellow-500">
                ⚠ 无法连接，但已保存（后端可能未启动）
              </p>
            )}
            {error && (
              <p className="text-sm text-red-500" role="alert">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button
                className="h-12 flex-1 rounded-full text-sm"
                onClick={() => void handleAdd()}
                disabled={testing}
              >
                {testing ? "检测中..." : connectionKind === "ssh" ? "连接服务器" : "添加"}
              </Button>
              {connections.length > 0 && (
                <Button
                  variant="ghost"
                  className="h-12 rounded-full px-6 text-sm"
                  onClick={() => {
                    setShowForm(false);
                    setError(null);
                    setTestResult(null);
                  }}
                >
                  取消
                </Button>
              )}
            </div>
          </div>
        )}

        {connections.length > 0 && !showForm && (
          <ul className="mt-6 space-y-3">
            {connections.map((conn) => (
              <li
                key={conn.id}
                className={`group flex flex-wrap items-center justify-between rounded-2xl border px-5 py-4 transition ${
                  conn.id === activeId
                    ? "border-primary/40 bg-primary/5"
                    : "border-border/60 bg-background/60 hover:border-border"
                }`}
              >
                {editingId === conn.id ? (
                  <div className="flex-1 space-y-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="h-9 w-full rounded-xl border border-border/60 bg-background/70 px-3 text-sm outline-none focus:border-primary/50"
                    />
                    <input
                      value={editUrl}
                      onChange={(e) => setEditUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleEditSave();
                        }
                      }}
                      className="h-9 w-full rounded-xl border border-border/60 bg-background/70 px-3 text-sm outline-none focus:border-primary/50"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="rounded-full px-4"
                        onClick={handleEditSave}
                      >
                        保存
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full px-4"
                        onClick={() => setEditingId(null)}
                      >
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => onSelect(conn.id)}
                    >
                      <p className="text-sm font-medium">{conn.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {conn.kind === "ssh" ? `${conn.sshHost}:${conn.sshBackendPort}` : conn.url || "内置本地后端未连接"}
                      </p>
                      {conn.available === false && conn.statusMessage ? (
                        <p className="mt-1 text-xs text-amber-600">
                          {conn.statusMessage}
                        </p>
                      ) : null}
                      {conn.browserMessage ? <p className="mt-1 text-xs text-amber-600">Browser: {conn.browserMessage}</p> : null}
                      {conn.isSystem && conn.runtimeSource ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Runtime: {conn.runtimeSource}
                          {conn.runtimeReleaseId
                            ? ` ${conn.runtimeReleaseId}`
                            : ""}
                        </p>
                      ) : null}
                    </button>
                    {(conn.canEdit !== false || conn.canDelete !== false) && (
                      <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                        {conn.canEdit !== false && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full px-3 text-xs text-muted-foreground"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleEdit(conn);
                            }}
                          >
                            编辑
                          </Button>
                        )}
                        {conn.canDelete !== false && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full px-3 text-xs text-red-500 hover:text-red-600"
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemove(conn.id);
                            }}
                          >
                            删除
                          </Button>
                        )}
                      </div>
                    )}
                    {shouldShowReconnectAction(conn) && onReconnect ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-2 rounded-full px-4"
                        onClick={(event) => {
                          event.stopPropagation();
                          void onReconnect(conn.id);
                        }}
                      >
                        恢复
                      </Button>
                    ) : null}
                  </>
                )}
                {conn.kind === "ssh" && conn.available && onForwardPort ? (
                  <RemotePortForwarding connection={conn} onForward={onForwardPort} />
                ) : null}
                {conn.kind === "ssh" && conn.available ? (
                  <div className="mt-3 w-full space-y-2 border-t border-border/50 pt-3 text-xs">
                    {!getConnectionAuth(conn.id)?.accessToken ? (
                      <>
                        <p className="font-medium">下一步：登录远端 Runweave</p>
                        <p className="text-muted-foreground">使用服务器上 Runweave 的账号密码登录，登录后回到连接管理添加项目。</p>
                        <Button size="sm" onClick={() => onSelect(conn.id)}>前往登录</Button>
                      </>
                    ) : <>
                      <p className="font-medium">添加远端项目</p>
                      <p className="text-muted-foreground">选择已有项目，或填写服务器上的项目目录。添加后点击连接名称进入终端。</p>
                      {(overviews[conn.id]?.projects ?? []).map((project) => {
                        const added = bindings.some((binding) => binding.connectionId === conn.id && binding.remoteProjectId === project.projectId);
                        return <div key={project.projectId} className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate">{project.name} · {project.path ?? "无目录"}</span>
                          <Button size="sm" variant={added ? "secondary" : "outline"} onClick={() => added ? unbindProject(conn.id, project.projectId) : bindProject(conn.id, project)}>
                            {added ? "移出桌面" : "加入桌面"}
                          </Button>
                        </div>;
                      })}
                      <div className="flex flex-wrap gap-2">
                        <input aria-label="远端项目名称" placeholder="项目名称" value={projectName[conn.id] ?? ""} onChange={(event) => setProjectName((previous) => ({ ...previous, [conn.id]: event.target.value }))} className="min-w-24 flex-1 rounded-md border border-border bg-background px-2 py-1" />
                        <input aria-label="远端项目目录" placeholder="Linux 绝对目录" value={projectDirectory[conn.id] ?? ""} onChange={(event) => setProjectDirectory((previous) => ({ ...previous, [conn.id]: event.target.value }))} className="min-w-32 flex-[2] rounded-md border border-border bg-background px-2 py-1" />
                        <Button size="sm" variant="outline" disabled={projectBusy === conn.id} onClick={() => {
                          const name = projectName[conn.id]?.trim();
                          const directory = projectDirectory[conn.id]?.trim();
                          const token = getConnectionAuth(conn.id)?.accessToken;
                          if (!name || !directory?.startsWith("/") || !token) { setError("请输入项目名称和 Linux 绝对目录，并先登录远端 Backend"); return; }
                          setProjectBusy(conn.id);
                          void createTerminalProject(conn.url, token, { name, path: directory }).then((project) => {
                            bindProject(conn.id, project);
                            useConnectionWorkspaceOverview.getState().update(conn.id, { projects: [...(useConnectionWorkspaceOverview.getState().byConnectionId[conn.id]?.projects ?? []), project] });
                            setProjectName((previous) => ({ ...previous, [conn.id]: "" }));
                            setProjectDirectory((previous) => ({ ...previous, [conn.id]: "" }));
                            setError(null);
                          }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setProjectBusy(null));
                        }}>创建并加入</Button>
                      </div>
                    </>}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {connections.length === 0 && !showForm && (
          <div className="mt-8 text-center">
            <p className="text-sm text-muted-foreground">
              暂无连接配置，请添加一个后端连接
            </p>
            <Button
              className="mt-4 rounded-full px-6"
              onClick={() => setShowForm(true)}
            >
              添加连接
            </Button>
          </div>
        )}
        {error && !showForm ? <p className="mt-4 text-sm text-red-500" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}
