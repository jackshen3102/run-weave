import { useState } from "react";
import { Button } from "./ui/button";
import type { ConnectionConfig } from "../features/connection/types";

interface ConnectionPageProps {
  connections: ConnectionConfig[];
  activeId: string | null;
  onAdd: (name: string, url: string) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, patch: { name?: string; url?: string }) => void;
}

export function ConnectionPage({
  connections,
  activeId,
  onAdd,
  onRemove,
  onSelect,
  onEdit,
}: ConnectionPageProps) {
  const [showForm, setShowForm] = useState(connections.length === 0);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

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

        {showForm && (
          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <label
                className="text-xs uppercase tracking-[0.24em] text-muted-foreground/70"
                htmlFor="conn-name"
              >
                连接名称
              </label>
              <input
                id="conn-name"
                placeholder="例如：本地开发"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-12 w-full rounded-[1.25rem] border border-border/60 bg-background/70 px-4 text-sm outline-none transition focus:border-primary/50"
              />
            </div>
            <div className="space-y-2">
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
            </div>

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
                {testing ? "检测中..." : "添加"}
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
                className={`group flex items-center justify-between rounded-2xl border px-5 py-4 transition ${
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
                        {conn.url}
                      </p>
                    </button>
                    <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
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
                    </div>
                  </>
                )}
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
      </section>
    </main>
  );
}
