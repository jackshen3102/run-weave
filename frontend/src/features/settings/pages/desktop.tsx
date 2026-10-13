import { useState } from "react";
import { DesktopConfigurationStatus } from "../../configuration/desktop-status";
import { FrontendVersion } from "../../runtime-status/versions";
import { Button } from "../../../components/ui/button";
import { useSettingsDraft } from "../edit-session";
export default function Desktop() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useSettingsDraft(false, busy);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!window.electronAPI?.getLocalConfigurationStatus)
    return <p>当前宿主不提供桌面诊断。</p>;
  return (
    <div className="space-y-3">
      <FrontendVersion />
      <DesktopConfigurationStatus embedded />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || !window.electronAPI.exportDesktopDiagnostics}
          onClick={() =>
            void run(() => window.electronAPI!.exportDesktopDiagnostics!())
          }
        >
          导出桌面诊断
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !window.electronAPI.reloadRuntime}
          onClick={() => {
            if (
              window.confirm(
                "重新加载本台运行时？本台连接会暂时中断，远端电脑不受影响。",
              )
            )
              void run(() => window.electronAPI!.reloadRuntime!());
          }}
        >
          重新加载本台运行时
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
