import { useEffect, useState } from "react";
import { useMemoizedFn } from "ahooks";
import { Settings } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { useResources } from "./resource-monitor-provider";
import { resourceMonitorApi } from "../../services/resource-monitor";
import { useSettingsDraft } from "../settings/edit-session";
export function ResourceSettings({
  onSaved,
  embedded = false,
}: {
  onSaved: () => void;
  embedded?: boolean;
}) {
  const resource = useResources();
  const [open, setOpen] = useState(embedded),
    [draft, setDraft] = useState<{
      monitor: boolean;
      alerts: boolean;
      remote: boolean;
      mac: boolean;
      revision: number;
      remoteRevision: number;
    } | null>(null);
  const [saving, setSaving] = useState(false),
    [error, setError] = useState<string | null>(null);
  const initialize = useMemoizedFn(() => {
    if (!resource.data) return;
    const data = resource.data;
    setDraft({
      monitor: data.settings.monitorEnabled,
      alerts: data.settings.alertsEnabled,
      revision: data.settings.revision,
      remote: data.remoteControl.enabled,
      remoteRevision: data.remoteControl.revision,
      mac: resource.macNotifications,
    });
    setError(null);
  });
  useEffect(() => {
    if (embedded && !draft && resource.data) initialize();
  }, [draft, embedded, initialize, resource.data]);
  const dirty =
    !!draft &&
    !!resource.data &&
    (draft.monitor !== resource.data.settings.monitorEnabled ||
      draft.alerts !== resource.data.settings.alertsEnabled ||
      draft.remote !== resource.data.remoteControl.enabled ||
      draft.mac !== resource.macNotifications);
  useSettingsDraft(embedded && dirty, embedded && saving);
  const save = useMemoizedFn(async () => {
    if (!draft || !resource.token || saving) return;
    setSaving(true);
    setError(null);
    let monitorSaved = false;
    try {
      const api = resourceMonitorApi(resource.apiBase, resource.token);
      const saved = await api.settings({
        revision: draft.revision,
        monitorEnabled: draft.monitor,
        alertsEnabled: draft.alerts,
      });
      resource.applySettings(saved);
      monitorSaved = true;
      setDraft((value) => value && { ...value, revision: saved.revision });
      if (
        resource.data?.canManageRemoteControl &&
        draft.remote !== resource.data.remoteControl.enabled
      ) {
        const permission = await api.remoteControl({
          revision: draft.remoteRevision,
          enabled: draft.remote,
        });
        resource.applyRemoteControl(permission);
        setDraft(
          (value) => value && { ...value, remoteRevision: permission.revision },
        );
      }
      resource.setMacNotifications(draft.mac);
      onSaved();
      if (!embedded) setOpen(false);
    } catch (cause) {
      setError(
        `${monitorSaved ? "监控设置已保存；其余设置未完成。" : ""}${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      setSaving(false);
    }
  });
  const content = (
    <div className="space-y-5" aria-busy={saving}>
      {draft ? (
        <fieldset disabled={saving} className="space-y-5">
          {(
            [
              ["monitor", "后台资源监控"],
              ["alerts", "资源占用提醒"],
              ["mac", "Mac 系统通知"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center justify-between gap-3 border-b pb-4 text-sm"
            >
              {label}
              <input
                type="checkbox"
                checked={draft[key]}
                disabled={
                  key === "mac" && !window.electronAPI?.showResourceNotification
                }
                onChange={(event) =>
                  setDraft({ ...draft, [key]: event.target.checked })
                }
              />
            </label>
          ))}
          {resource.data?.canManageRemoteControl ? (
            <label className="flex items-center justify-between gap-3 text-sm">
              允许远程结束进程
              <input
                type="checkbox"
                checked={draft.remote}
                onChange={(event) =>
                  setDraft({ ...draft, remote: event.target.checked })
                }
              />
            </label>
          ) : (
            <p className="text-sm text-muted-foreground">
              远程结束进程：
              {resource.data?.remoteControl.enabled ? "已授权" : "未授权"}
              。仅电脑本机可修改授权。
            </p>
          )}
          <p className="text-xs leading-6 text-muted-foreground">
            后台每分钟采样，关闭页面后仍继续观察。允许远程控制后，普通结束和强制结束仍需分别确认；系统及
            Runweave 控制进程受保护。
          </p>
          <p className="text-xs leading-6 text-muted-foreground">
            能耗影响 ≥ 100（仅电池供电），或 RSS 合计 ≥ 4
            GiB；至少六次有效采样跨满五分钟。内存占用不代表耗电量。
            {!window.electronAPI?.showResourceNotification
              ? "普通 Web 使用应用内提醒。"
              : "系统通知需要在 macOS 中允许 Runweave 发送通知。"}
          </p>
        </fieldset>
      ) : (
        <p role="status">{resource.error ?? "正在读取监控设置…"}</p>
      )}
      {(error || resource.notificationError) && (
        <p role="alert" className="text-sm text-destructive">
          {error ?? resource.notificationError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          disabled={saving}
          onClick={() => {
            initialize();
            if (!embedded) setOpen(false);
          }}
        >
          取消修改
        </Button>
        <Button
          disabled={saving || !draft || !resource.token || !dirty}
          onClick={() => void save()}
        >
          {saving ? "保存中…" : "保存修改"}
        </Button>
      </div>
    </div>
  );
  if (embedded) return content;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={!resource.data}
        onClick={() => {
          initialize();
          setOpen(true);
        }}
      >
        <Settings className="mr-2 h-4 w-4" />
        提醒设置
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!saving) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>资源提醒设置</DialogTitle>
            <DialogDescription>后台资源监控与系统通知</DialogDescription>
          </DialogHeader>
          {content}
        </DialogContent>
      </Dialog>
    </>
  );
}
