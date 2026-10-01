import { useLocation } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { useResources } from "./resource-monitor-provider";
export function ResourceNotice({
  onOpen,
}: {
  onOpen: (appKey: string) => void;
}) {
  const resource = useResources();
  const location = useLocation();
  const alert = resource.notice;
  if (!alert || location.pathname === "/system-monitor" || !resource.token)
    return null;
  return (
    <aside
      role="status"
      className="fixed bottom-4 right-4 z-40 max-w-sm rounded-lg border border-amber-500/40 bg-card p-4 shadow-lg"
    >
      <strong className="text-sm">
        {alert.appName}{" "}
        {alert.ruleId === "energy" ? "能耗影响较高" : "内存占用较大"}
      </strong>
      <p className="mt-1 text-xs text-muted-foreground">
        近 5 分钟多次检测到高占用
        {alert.ruleId === "memory" ? "；内存占用不代表耗电量" : ""}
      </p>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            resource.dismissNotice();
            onOpen(alert.appKey);
          }}
        >
          查看进程
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => resource.dismissNotice()}
        >
          关闭
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void resource
              .snooze(alert.alertId)
              .then(() => resource.dismissNotice())
              .catch(() => onOpen(alert.appKey));
          }}
        >
          忽略 1 小时
        </Button>
      </div>
    </aside>
  );
}
