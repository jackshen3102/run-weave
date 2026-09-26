import { useEffect, useRef, useState } from "react";
import { useMemoizedFn } from "ahooks";
import type { ConfigurationValue, PublicConfigurationField, PublicConfigurationStatus } from "@runweave/shared/configuration";
import { requestConfiguration } from "../../services/configuration";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

const states = { applied: "已生效", restartRequired: "等待所属服务重启", error: "配置错误", unconfigured: "未配置" };
export function ConfigurationPanel({ apiBase, token }: { apiBase: string; token: string | null }) {
  // The parent keys this component by connection and token: drafts never cross connections.
  const [status, setStatus] = useState<PublicConfigurationStatus | null>(null);
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const run = useMemoizedFn(async (save = false) => {
    if (!token) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setFailure(null);
    try {
      let patch;
      if (save && status?.savedRevision != null && status.digest) {
        const changes: Record<string, ConfigurationValue> = {};
        for (const [key, value] of Object.entries(draft)) {
          const field = status.fields.find(field => field.path === key);
          if (!field) throw new Error("字段列表已变化，请重新加载。");
          changes[key] = parseValue(field, value);
        }
        patch = { expectedRevision: status.savedRevision, expectedDigest: status.digest, expectedEnvironment: status.environment, changes };
      }
      const next = await requestConfiguration(apiBase, token, controller.signal, patch);
      if (controller.signal.aborted) return;
      if (status && (next.environment.kind !== status.environment.kind || next.environment.instanceId !== status.environment.instanceId)) throw new Error("连接实例已变化，请关闭并重新打开配置。");
      setStatus(next); setDraft({});
    } catch (error) { if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : "配置操作失败"); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  });
  return <details className="rounded-xl border border-border p-4">
    <summary className="cursor-pointer font-medium">当前连接电脑的配置</summary>
    <div className="mt-3 space-y-4">
      <p className="break-all text-xs text-muted-foreground">{apiBase || window.location.origin}</p>
      <Button variant="secondary" size="sm" disabled={busy || !token} onClick={() => void run()}>加载配置</Button>
      {!token && <p>登录后可管理当前连接的配置。</p>}
      {failure && <p role="alert" className="text-sm text-red-500">{failure}</p>}
      {status && <>
        <p className="text-xs">{status.environment.kind === "stable" ? "Stable" : "Dev Session"} · {status.environment.instanceId} · 保存版本 {status.savedRevision ?? "不可读取"}</p>
        {status.diskError && <p role="alert">磁盘配置无法读取，请在当前电脑运行 rw config doctor。</p>}
        {status.fields.filter(field => !field.path.includes("<")).map(field => {
          const changed = Object.hasOwn(draft, field.path);
          const value = changed ? draft[field.path] : status.values[field.path];
          const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
          const consumer = status.consumers[field.domain];
          return <div key={field.path} className="space-y-1 border-b border-border/60 pb-3">
            <label className="text-sm" htmlFor={`config-${field.path}`}>{field.description}</label>
            <p className="text-xs text-muted-foreground">{consumer ? states[consumer.state] : "状态未知"}{consumer?.appliedRevision != null ? ` · 生效版本 ${consumer.appliedRevision}` : ""}</p>
            {field.sensitive ? <>
              <select disabled={busy} aria-label={`${field.description}操作`} className="h-9 w-full rounded border bg-background px-2 text-sm" value={!changed ? "keep" : draft[field.path] === null ? "delete" : "replace"} onChange={event => setDraft(current => {
                const next = { ...current }; if (event.target.value === "keep") delete next[field.path]; else next[field.path] = event.target.value === "delete" ? null : ""; return next;
              })}>
                <option value="keep">{status.values[`${field.path}.configured`] ? "已配置，保留现有值" : "未配置，保持不变"}</option><option value="replace">替换</option><option value="delete">删除</option>
              </select>
              {changed && draft[field.path] !== null && <Input disabled={busy} id={`config-${field.path}`} type="password" autoComplete="new-password" value={draft[field.path] ?? ""} onChange={event => setDraft(current => ({ ...current, [field.path]: event.target.value }))} />}
            </> : <Input disabled={busy} id={`config-${field.path}`} value={text} placeholder={"value" in field.default && field.default.value != null ? String(field.default.value) : "未设置"} onChange={event => setDraft(current => ({ ...current, [field.path]: event.target.value }))} />}
            {!field.sensitive && <p className="text-[11px] text-muted-foreground">{field.type === "boolean" ? "填写 true 或 false" : field.type.startsWith("array") ? '填写 JSON 数组，例如 ["id1", "id2"]' : "留空恢复默认值"}</p>}
          </div>;
        })}
        <Button disabled={busy || !Object.keys(draft).length || status.savedRevision == null} onClick={() => void run(true)}>{busy ? "处理中…" : "保存配置"}</Button>
      </>}
    </div>
  </details>;
}
function parseValue(field: PublicConfigurationField, input: string | null): ConfigurationValue {
  if (input === null || !field.sensitive && input === "") return null;
  if (field.sensitive && !input) throw new Error("替换凭据时请填写新值；删除请使用删除选项。");
  if (field.type === "string") return input;
  if (field.type === "boolean" && !["true", "false"].includes(input)) throw new Error(`${field.description}需要 true 或 false。`);
  try { return JSON.parse(input) as ConfigurationValue; } catch { throw new Error(`${field.description}格式不正确。`); }
}
