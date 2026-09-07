import { useState, type ComponentProps, type MouseEvent } from "react";
import { useMemoizedFn } from "ahooks";

export function SuijiEntryLink({
  children,
  ...props
}: Omit<ComponentProps<"a">, "href" | "target" | "rel" | "onClick">) {
  const [error, setError] = useState("");
  const open = useMemoizedFn((event: MouseEvent<HTMLAnchorElement>) => {
    if (!window.electronAPI?.isElectron) return;
    event.preventDefault();
    setError("");
    if (!window.electronAPI.openSuijiWindow) {
      setError("请更新桌面客户端后使用随记独立窗口");
      return;
    }
    void window.electronAPI.openSuijiWindow().catch(() => {
      setError("无法打开随记窗口，请重试");
    });
  });
  return (
    <a
      {...props}
      href="/suiji"
      target="_blank"
      rel="noopener noreferrer"
      title="在新窗口打开随记"
      onClick={open}
    >
      {children}
      {error ? (
        <span role="alert" className="ml-2 text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </a>
  );
}
