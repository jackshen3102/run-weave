import { useEffect, useRef, useState } from "react";
import { Button } from "../../../ui/button";
import { HttpError } from "../../../../services/http";
import { getTerminalVideoPreviewTicket } from "../../../../services/terminal/preview";

interface Props {
  apiBase: string;
  token: string;
  projectId: string;
  path: string;
  onAuthExpired?: () => void;
}

export function TerminalVideoPreview({
  apiBase,
  token,
  projectId,
  path,
  onAuthExpired,
}: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const player = video.current;
    setSource(null);
    setFailure(null);
    void getTerminalVideoPreviewTicket(
      apiBase,
      token,
      projectId,
      path,
      controller.signal,
    )
      .then((ticket) => {
        if (!controller.signal.aborted)
          setSource(`${apiBase.replace(/\/$/, "")}${ticket.path}`);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && error.status === 401)
          onAuthExpired?.();
        setFailure(
          error instanceof HttpError && error.status === 404
            ? "视频文件不存在，或电脑版本尚不支持视频预览"
            : error instanceof HttpError && error.status === 415
              ? "此文件不是受支持的视频格式"
              : error instanceof Error
                ? error.message
                : String(error),
        );
      });
    return () => {
      controller.abort();
      if (player) {
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
    };
  }, [apiBase, token, projectId, path, retry, onAuthExpired]);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 bg-background p-3">
      {failure ? (
        <div className="flex flex-col items-start gap-2 p-3">
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </Button>
        </div>
      ) : !source ? (
        <p role="status" className="p-3 text-sm text-muted-foreground">
          正在加载视频…
        </p>
      ) : null}
      <video
        ref={video}
        aria-label="视频预览播放器"
        controls
        playsInline
        preload="metadata"
        src={source ?? undefined}
        className={
          failure || !source
            ? "hidden"
            : "min-h-0 w-full flex-1 bg-black object-contain"
        }
        onError={() => {
          if (source)
            setFailure(
              "视频无法播放。文件可能已变化、播放链接已过期，或编码不受系统支持。",
            );
        }}
      />
    </div>
  );
}
