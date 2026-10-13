import { useState } from "react";
import { useNotificationPreference } from "../../system-monitor/notification-preference";
import { useResources } from "../../system-monitor/resource-monitor-provider";
export default function Notifications() {
  const { notificationError } = useResources();
  const enabled = useNotificationPreference((state) => state.enabled),
    save = useNotificationPreference((state) => state.setEnabled);
  const [error, setError] = useState("");
  const supported = !!window.electronAPI?.showResourceNotification;
  return (
    <section className="rounded-xl border p-5">
      <label className="flex items-center justify-between gap-4">
        <div>
          <h2 className="font-medium">Mac 系统通知</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            系统通知需要在 macOS 中允许 Runweave
            发送通知。应用内资源提醒仍保留。
          </p>
        </div>
        <input
          type="checkbox"
          aria-label="Mac 系统通知"
          checked={enabled}
          disabled={!supported}
          onChange={(event) => {
            try {
              save(event.target.checked);
              setError("");
            } catch {
              setError("无法保存通知偏好，请重试。");
            }
          }}
        />
      </label>
      {!supported && (
        <p className="mt-4 text-sm text-muted-foreground">
          当前宿主不提供 Mac 通知。
        </p>
      )}
      {(error || notificationError) && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error || notificationError}
        </p>
      )}
    </section>
  );
}
