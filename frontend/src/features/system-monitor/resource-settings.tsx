import { useState } from "react";
import { Settings } from "lucide-react";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { useResources } from "./resource-monitor-provider";
import { resourceMonitorApi } from "../../services/resource-monitor";
export function ResourceSettings({ onSaved }: { onSaved: () => void }) {
  const resource = useResources();
  const [open, setOpen] = useState(false);
  const [monitor, setMonitor] = useState(true);
  const [alerts, setAlerts] = useState(true);
  const [mac, setMac] = useState(false);
  const [revision, setRevision] = useState(0);
  const [remote, setRemote] = useState(false);
  const [remoteRevision, setRemoteRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        disabled={!resource.data}
        onClick={() => {
          const settings = resource.data!.settings;
          setMonitor(settings.monitorEnabled);
          setAlerts(settings.alertsEnabled);
          setRevision(settings.revision);
          setMac(resource.macNotifications);
          setRemote(resource.data!.remoteControl?.enabled ?? false);
          setRemoteRevision(resource.data!.remoteControl?.revision ?? 0);
          setError(null);
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
            <DialogDescription>
              后台每分钟采样，关闭页面后仍继续观察。
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center justify-between gap-3 text-sm">
            后台资源监控
            <input
              type="checkbox"
              checked={monitor}
              onChange={(event) => setMonitor(event.target.checked)}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            资源占用提醒
            <input
              type="checkbox"
              checked={alerts}
              onChange={(event) => setAlerts(event.target.checked)}
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            Mac 系统通知
            <input
              type="checkbox"
              checked={mac}
              disabled={!window.electronAPI?.showResourceNotification}
              onChange={(event) => setMac(event.target.checked)}
            />
          </label>
          {resource.data?.canManageRemoteControl ? (
            <>
              <label className="flex items-center justify-between gap-3 text-sm">
                允许远程结束进程
                <input
                  type="checkbox"
                  checked={remote}
                  onChange={(event) => setRemote(event.target.checked)}
                />
              </label>
              <p className="text-xs leading-6 text-muted-foreground">
                允许已登录客户端远程结束这台电脑的普通进程，包括再次确认后的强制结束。
                系统及 Runweave
                控制进程仍受保护。关闭后撤销远程操作权限，不影响查看排行。
              </p>
            </>
          ) : resource.data?.remoteControl ? (
            <p className="text-xs text-muted-foreground">
              远程结束进程：
              {resource.data.remoteControl.enabled ? "已授权" : "未授权"}
              。仅电脑本机可修改授权。
            </p>
          ) : null}
          <p className="text-xs leading-6 text-muted-foreground">
            能耗影响 ≥ 100（仅电池供电），或 RSS 合计 ≥ 4
            GiB；至少六次有效采样跨满五分钟。内存占用不代表耗电量。
            {!window.electronAPI?.showResourceNotification
              ? " 普通 Web 使用应用内提醒。"
              : "系统通知需要在 macOS 中允许 Runweave 发送通知。"}
          </p>
          {error || resource.notificationError ? (
            <p role="alert" className="text-sm text-destructive">
              {error ?? resource.notificationError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={saving}
              onClick={async () => {
                if (!resource.token) return;
                setSaving(true);
                setError(null);
                try {
                  const saved = await resourceMonitorApi(
                    resource.apiBase,
                    resource.token,
                  ).settings({
                    revision,
                    monitorEnabled: monitor,
                    alertsEnabled: alerts,
                  });
                  resource.applySettings(saved);
                  setRevision(saved.revision);
                  if (
                    resource.data?.canManageRemoteControl &&
                    remote !== resource.data.remoteControl.enabled
                  ) {
                    const permission = await resourceMonitorApi(
                      resource.apiBase,
                      resource.token,
                    ).remoteControl({
                      revision: remoteRevision,
                      enabled: remote,
                    });
                    resource.applyRemoteControl(permission);
                    setRemoteRevision(permission.revision);
                  }
                  resource.setMacNotifications(mac);
                  onSaved();
                  setOpen(false);
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
