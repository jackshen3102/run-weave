import { useEffect, useState } from "react";
import { HttpError } from "../../services/http";
import { getTerminalProjectPreviewAsset } from "../../services/terminal";

interface TerminalImagePreviewProps {
  apiBase: string;
  token: string;
  projectId: string;
  path: string;
  refreshKey: number;
  onAuthExpired?: () => void;
}

export function TerminalImagePreview({
  apiBase,
  token,
  projectId,
  path,
  refreshKey,
  onAuthExpired,
}: TerminalImagePreviewProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let nextObjectUrl: string | null = null;
    setLoading(true);
    setError(null);

    getTerminalProjectPreviewAsset(apiBase, token, projectId, path)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        nextObjectUrl = URL.createObjectURL(blob);
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
        setError(
          unknownError instanceof Error ? unknownError.message : String(unknownError),
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
  }, [apiBase, onAuthExpired, path, projectId, refreshKey, token]);

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
        {error}
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
    <div className="flex h-full min-h-0 items-center justify-center bg-slate-950 p-4">
      <img
        src={objectUrl}
        alt={path}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
