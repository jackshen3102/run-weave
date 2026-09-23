import type { TerminalPreviewChangeKind } from "@runweave/shared/terminal/preview";
import { RunweaveImagePreview } from "@runweave/common/terminal";
import "@runweave/common/terminal/image-lightbox.css";
import { useEffect, useState } from "react";
import { HttpError } from "../../../../services/http";
import { getTerminalProjectPreviewAsset } from "../../../../services/terminal/index";

interface TerminalImagePreviewProps {
  apiBase: string;
  token: string;
  projectId: string;
  path: string;
  refreshKey: number;
  onAuthExpired?: () => void;
  change?: { kind: TerminalPreviewChangeKind; side: "old" | "new"; version: string };
  onReload?: () => void;
}

export function TerminalImagePreview({
  apiBase,
  token,
  projectId,
  path,
  refreshKey,
  onAuthExpired,
  change,
  onReload,
}: TerminalImagePreviewProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  const changeKind = change?.kind;
  const changeSide = change?.side;
  const changeVersion = change?.version;

  useEffect(() => {
    let cancelled = false;
    let nextObjectUrl: string | null = null;
    setLoading(true);
    setError(null);

    getTerminalProjectPreviewAsset(apiBase, token, projectId, path,
      changeKind && changeSide && changeVersion ? { kind: changeKind, side: changeSide, version: changeVersion } : undefined)
      .then(async (blob) => {
        if (cancelled) {
          return;
        }
        nextObjectUrl = URL.createObjectURL(blob);
        const decoded = new Image();
        decoded.src = nextObjectUrl;
        try { await decoded.decode(); }
        catch { throw new Error("图片无法解码，请重新加载或检查文件格式"); }
        if (cancelled) return;
        setObjectUrl((previousUrl) => {
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }
          return nextObjectUrl;
        });
      })
      .catch((unknownError: unknown) => {
        if (cancelled) {
          return;
        }
        if (unknownError instanceof HttpError && unknownError.status === 401) {
          onAuthExpired?.();
        }
        setObjectUrl((previousUrl) => {
          if (previousUrl) {
            URL.revokeObjectURL(previousUrl);
          }
          return null;
        });
        if (nextObjectUrl) { URL.revokeObjectURL(nextObjectUrl); nextObjectUrl = null; }
        setError(
          unknownError instanceof HttpError && unknownError.status === 409
            ? "图片版本已变化，请重新加载"
            : unknownError instanceof Error
            ? unknownError.message
            : String(unknownError),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (nextObjectUrl) {
        URL.revokeObjectURL(nextObjectUrl);
      }
    };
  }, [apiBase, onAuthExpired, path, projectId, refreshKey, token, changeKind, changeSide, changeVersion, retry]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Loading image...
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-rose-300">
        <div>{error}<button className="ml-3 underline" onClick={() => { setRetry((value) => value + 1); onReload?.(); }}>重新加载</button></div>
      </div>
    );
  }
  if (!objectUrl) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        No image selected
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0 bg-slate-950">
      <RunweaveImagePreview src={objectUrl} alt={path} title={path} />
    </div>
  );
}
