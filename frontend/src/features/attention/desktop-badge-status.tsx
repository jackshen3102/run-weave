import { useEffect, useState } from "react";
import type { TerminalBadgeStatus } from "@runweave/shared/terminal-unread";

export function DesktopBadgeStatus() {
  const [status, setStatus] = useState<TerminalBadgeStatus | null>(null);
  useEffect(() => {
    const read = window.electronAPI?.getTerminalBadgeStatus;
    if (!read) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await read();
        if (!disposed) setStatus(value);
      } catch {
        if (!disposed) setStatus(null);
      } finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);
  if (!status) return null;
  return (
    <p className="mt-3 text-sm text-muted-foreground" role="status">
      {status.state === "ready" ? `未读已同步 · ${status.count} 个终端` : status.reason}
      {status.state !== "ready" && status.count !== null ? ` · 上次同步 ${status.count} 个终端` : ""}
    </p>
  );
}
