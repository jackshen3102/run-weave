import { StatusNotice } from "../../status-notice";
import { useMemoizedFn } from "ahooks";
import { useState } from "react";
import { useSnapshotShareStore } from "../../../features/terminal/state/snapshot-share-store";

// Mounted outside connection-keyed providers so an in-flight share keeps its
// completion feedback even after navigation or a Backend switch.
export function TerminalSnapshotShareNotification() {
  const result = useSnapshotShareStore((state) => state.result);
  const error = useSnapshotShareStore((state) => state.error);
  const dismiss = useSnapshotShareStore((state) => state.dismiss);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const openSnapshot = useMemoizedFn(async () => {
    if (!result) return;
    try {
      if (window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(result.url);
      } else {
        window.open(result.url, "_blank", "noopener,noreferrer");
      }
    } catch {
      setFailedUrl(result.url);
    }
  });
  if (!result && !error) return null;
  return (
    <StatusNotice kind="snapshot-share" noticeKey={result ?? error} onDismiss={dismiss} duration={result ? 0 : 8_000}
      className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-slate-100 shadow-lg">
      <div className="flex items-start justify-between gap-2">
        <span>{error ?? (result?.copied ? "快照链接已复制，24 小时后失效。" : "快照已创建，24 小时后失效。复制失败，请手动复制链接。")}</span>
      </div>
      {result ? <>
        <input aria-label="终端快照链接" readOnly value={result.url} onFocus={(event) => event.currentTarget.select()} className="w-full rounded border border-slate-700 bg-slate-950 p-1 text-xs" />
        <button type="button" className="self-start text-sky-400 underline" onClick={() => { void openSnapshot(); }}>打开快照</button>
        {failedUrl === result.url ? <span>无法打开快照，请手动复制链接。</span> : null}
      </> : null}
    </StatusNotice>
  );
}
