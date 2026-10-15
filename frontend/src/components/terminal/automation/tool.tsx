import { useMemoizedFn } from "ahooks";
import {
  Activity,
  ExternalLink,
  MousePointer2,
  Pin,
  PinOff,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  TerminalBrowserAutomationActor,
  TerminalBrowserAutomationFrame,
  TerminalBrowserAutomationSnapshot,
  TerminalBrowserAutomationTargetSnapshot,
} from "@runweave/shared/terminal-browser-automation";
import type { TerminalSessionListItem } from "@runweave/shared/terminal/session";
import { useTerminalPreviewStore } from "../../../features/terminal/preview/store";

interface TerminalBrowserAutomationToolProps {
  active: boolean;
  sessions: TerminalSessionListItem[];
}

type DisplayFrame = Pick<
  TerminalBrowserAutomationFrame,
  "targetId" | "width" | "height"
>;

interface AutomationCard {
  key: string;
  actor: TerminalBrowserAutomationActor;
  connectionCount: number;
  profileId: string;
  browserGroupId: string | null;
  targets: TerminalBrowserAutomationTargetSnapshot[];
}

const EMPTY_SNAPSHOT: TerminalBrowserAutomationSnapshot = {
  revision: 0,
  connections: [],
  targets: [],
};

function getActorKey(actor: TerminalBrowserAutomationActor): string {
  return actor.kind === "terminal"
    ? `terminal:${actor.terminalSessionId}`
    : `unattributed:${actor.connectionId}`;
}

function getSessionLabel(
  actor: TerminalBrowserAutomationActor,
  sessions: TerminalSessionListItem[],
): string {
  if (actor.kind === "unattributed") {
    return "未归属自动化";
  }
  const session = sessions.find(
    (candidate) => candidate.terminalSessionId === actor.terminalSessionId,
  );
  return (
    session?.alias?.trim() || `Terminal ${actor.terminalSessionId.slice(0, 8)}`
  );
}

function actionLabel(target: TerminalBrowserAutomationTargetSnapshot): string {
  switch (target.action) {
    case "click":
      return "点击";
    case "input":
      return "正在输入";
    case "scroll":
      return "滚动";
    case "navigate":
      return "导航";
    case "reload":
      return "刷新";
    case "tool":
      return `${target.tool?.name ?? "网页工具"} · ${
        target.tool?.status === "succeeded" ? "已完成" :
          target.tool?.status === "unknown" ? "结果待确认" : "调用中"
      }`;
    default:
      return target.loading ? "加载中" : "空闲";
  }
}

function groupCards(
  snapshot: TerminalBrowserAutomationSnapshot,
): AutomationCard[] {
  const cards = new Map<string, AutomationCard>();
  for (const connection of snapshot.connections) {
    const key = getActorKey(connection.actor);
    const card = cards.get(key);
    if (card) {
      card.connectionCount += 1;
      continue;
    }
    cards.set(key, {
      key,
      actor: connection.actor,
      connectionCount: 1,
      profileId: connection.profileId,
      browserGroupId: connection.browserGroupId,
      targets: [],
    });
  }
  for (const target of snapshot.targets) {
    for (const key of target.actorKeys) {
      cards.get(key)?.targets.push(target);
    }
  }
  return [...cards.values()];
}

export function TerminalBrowserAutomationTool({
  active,
  sessions,
}: TerminalBrowserAutomationToolProps) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [mainMaxEdge, setMainMaxEdge] = useState(1280);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [documentVisible, setDocumentVisible] = useState(
    document.visibilityState === "visible",
  );
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decodeGenerationRef = useRef(0);
  const lastTargetChangeRef = useRef(0);
  const selectedTargetIdRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const activateBrowser = useTerminalPreviewStore(
    (state) => state.activateBrowser,
  );

  const handleFrame = useMemoizedFn(
    async (incoming: TerminalBrowserAutomationFrame) => {
      let generation = decodeGenerationRef.current;
      let bitmap: ImageBitmap | undefined;
      try {
        if (
          !active ||
          !documentVisible ||
          incoming.targetId !== selectedTargetIdRef.current
        ) {
          return;
        }
        generation = ++decodeGenerationRef.current;
        bitmap = await createImageBitmap(
          new Blob([Uint8Array.from(incoming.bytes)], {
            type: incoming.mimeType,
          }),
        );
        const canvas = canvasRef.current;
        if (
          !canvas ||
          generation !== decodeGenerationRef.current ||
          incoming.targetId !== selectedTargetIdRef.current
        ) {
          return;
        }
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("无法显示预览画面");
        }
        // Keep the previous pixels until decoding finishes. Resize and draw in
        // the same task so the compositor never presents an empty canvas.
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        setFrame((current) =>
          current?.targetId === incoming.targetId &&
          current.width === incoming.width &&
          current.height === incoming.height
            ? current
            : {
                targetId: incoming.targetId,
                width: incoming.width,
                height: incoming.height,
              },
        );
        setDecodeError(null);
      } catch {
        if (generation === decodeGenerationRef.current) {
          setDecodeError("画面解码失败，等待下一帧");
        }
      } finally {
        bitmap?.close();
        // Acknowledge this exact frame, including discarded/failed frames.
        void window.electronAPI?.terminalBrowserAutomationAcknowledgeFrame?.({
          targetId: incoming.targetId,
          sequence: incoming.sequence,
        });
      }
    },
  );

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      ?.terminalBrowserAutomationGetSnapshot?.()
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
        }
      });
    const unsubscribeState =
      window.electronAPI?.onTerminalBrowserAutomationStateChanged?.((next) => {
        setSnapshot((current) =>
          next.revision >= current.revision ? next : current,
        );
      });
    const unsubscribeFrame =
      window.electronAPI?.onTerminalBrowserAutomationFrame?.(handleFrame);
    return () => {
      cancelled = true;
      unsubscribeState?.();
      unsubscribeFrame?.();
      decodeGenerationRef.current += 1;
      void window.electronAPI?.terminalBrowserAutomationSetViewState?.({
        visible: false,
        selectedTargetId: null,
        mainMaxEdge: 1,
      });
    };
  }, [handleFrame]);

  useEffect(() => {
    const onVisibilityChange = () => {
      setDocumentVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  const hasConnections = snapshot.connections.length > 0;
  useEffect(() => {
    const element = mainRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) {
        return;
      }
      const { width, height } = entry.contentRect;
      setMainMaxEdge(
        Math.min(
          1280,
          Math.max(
            64,
            Math.ceil(
              (Math.max(width, height) * window.devicePixelRatio) / 64,
            ) * 64,
          ),
        ),
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasConnections]);

  const selectedStillExists = snapshot.targets.some(
    (target) => target.targetId === selectedTargetId,
  );
  const latestActionTargetId = [...snapshot.targets]
    .filter((target) => target.action !== "idle")
    .sort(
      (left, right) => (right.actionUntil ?? 0) - (left.actionUntil ?? 0),
    )[0]?.targetId;
  const fallbackTargetId =
    latestActionTargetId ?? snapshot.targets[0]?.targetId ?? null;
  useEffect(() => {
    if (!selectedStillExists) {
      setSelectedTargetId(fallbackTargetId);
      setPinned(false);
      return;
    }
    if (
      pinned ||
      !latestActionTargetId ||
      latestActionTargetId === selectedTargetId
    ) {
      return;
    }
    // Coalesce bursts across tabs and keep each automatically selected page
    // visible for at least a second. Manual selection remains immediate.
    const delay = Math.max(
      350,
      1_000 - (performance.now() - lastTargetChangeRef.current),
    );
    const timer = window.setTimeout(
      () => setSelectedTargetId(latestActionTargetId),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [
    fallbackTargetId,
    latestActionTargetId,
    pinned,
    selectedStillExists,
    selectedTargetId,
  ]);

  useEffect(() => {
    selectedTargetIdRef.current = selectedTargetId;
    lastTargetChangeRef.current = performance.now();
    decodeGenerationRef.current += 1;
    setFrame(null);
    setDecodeError(null);
  }, [selectedTargetId]);

  useEffect(() => {
    // Also invalidate decoding when hidden; a late frame must not reappear
    // after switching away and back to this tool.
    decodeGenerationRef.current += 1;
  }, [active, documentVisible, hasConnections]);

  useEffect(() => {
    void window.electronAPI?.terminalBrowserAutomationSetViewState?.({
      visible: active && documentVisible,
      selectedTargetId,
      mainMaxEdge,
    });
  }, [active, documentVisible, mainMaxEdge, selectedTargetId]);

  const selectedTarget = snapshot.targets.find(
    (target) => target.targetId === selectedTargetId,
  );

  const cards = useMemo(() => groupCards(snapshot), [snapshot]);
  const openInBrowser = useMemoizedFn(async () => {
    if (!selectedTarget) {
      return;
    }
    await window.electronAPI?.terminalBrowserAutomationSetViewState?.({
      visible: false,
      selectedTargetId: null,
      mainMaxEdge: 1,
    });
    await window.electronAPI?.terminalBrowserShow?.(selectedTarget.tabId);
    activateBrowser(selectedTarget.profileId, null);
  });
  const resumeFollowing = useMemoizedFn(() => {
    setPinned(false);
    const latest = [...snapshot.targets]
      .filter((target) => target.action !== "idle")
      .sort(
        (left, right) => (right.actionUntil ?? 0) - (left.actionUntil ?? 0),
      )[0];
    if (latest) {
      setSelectedTargetId(latest.targetId);
    }
  });

  if (snapshot.connections.length === 0) {
    return (
      <div
        className="flex h-full items-center justify-center bg-slate-950 px-6"
        data-testid="terminal-browser-automation-empty"
      >
        <div className="max-w-sm text-center">
          <Activity className="mx-auto mb-3 h-7 w-7 text-slate-600" />
          <p className="text-sm text-slate-300">当前没有浏览器自动化</p>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Terminal 连接 Browser Profile 后，会在这里出现受控页面。
          </p>
        </div>
      </div>
    );
  }

  const pointer = selectedTarget?.pointer;
  const pointerLeft =
    selectedTarget && pointer
      ? `${Math.max(0, Math.min(100, (pointer.x / selectedTarget.viewportWidth) * 100))}%`
      : null;
  const pointerTop =
    selectedTarget && pointer
      ? `${Math.max(0, Math.min(100, (pointer.y / selectedTarget.viewportHeight) * 100))}%`
      : null;

  return (
    <div
      className="grid h-full min-h-0 grid-cols-[minmax(190px,0.38fr)_minmax(0,1fr)] bg-slate-950"
      data-testid="terminal-browser-automation"
    >
      <div className="min-h-0 overflow-y-auto border-r border-slate-800 p-2">
        {cards.map((card) => (
          <section
            className={[
              "mb-2 rounded-lg border bg-slate-900/60 p-2",
              card.actor.kind === "unattributed"
                ? "border-amber-800/80"
                : "border-slate-800",
            ].join(" ")}
            data-testid={`automation-card-${card.key}`}
            key={card.key}
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-slate-200">
                  {getSessionLabel(card.actor, sessions)}
                </p>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">
                  {card.profileId} · {card.browserGroupId ?? "all groups"}
                </p>
              </div>
              <span className="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-[9px] text-slate-400">
                {card.connectionCount} conn
              </span>
            </div>
            <div className="space-y-1">
              {card.targets.map((target) => {
                const selected = target.targetId === selectedTargetId;
                return (
                  <button
                    type="button"
                    className={[
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                      selected
                        ? "bg-sky-950/70 text-sky-100 ring-1 ring-sky-800"
                        : "text-slate-300 hover:bg-slate-800/80",
                    ].join(" ")}
                    data-testid={`automation-target-${target.targetId}`}
                    key={target.targetId}
                    onClick={() => {
                      setPinned(true);
                      setSelectedTargetId(target.targetId);
                    }}
                  >
                    {target.faviconDataUrl ? (
                      <img
                        alt=""
                        className="h-4 w-4 shrink-0 rounded-sm"
                        src={target.faviconDataUrl}
                      />
                    ) : (
                      <span className="h-2 w-2 shrink-0 rounded-full bg-slate-600" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px]">
                        {target.title || "Untitled"}
                      </span>
                      <span className="block truncate text-[9px] text-slate-500">
                        {target.url || "about:blank"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[9px] text-slate-500">
                      {actionLabel(target)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-slate-800 px-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs text-slate-200">
              {selectedTarget?.title || "选择一个受控页面"}
            </p>
            {selectedTarget ? (
              <p className="truncate text-[9px] text-slate-500">
                {selectedTarget.url || "about:blank"}
              </p>
            ) : null}
          </div>
          {pinned ? (
            <button
              type="button"
              className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-amber-300 hover:bg-slate-800"
              onClick={resumeFollowing}
            >
              <PinOff className="h-3 w-3" /> 恢复跟随
            </button>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-slate-500">
              <Pin className="h-3 w-3" /> 自动跟随
            </span>
          )}
          <button
            type="button"
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-sky-300 hover:bg-slate-800 disabled:text-slate-600"
            disabled={!selectedTarget}
            onClick={() => void openInBrowser()}
          >
            <ExternalLink className="h-3 w-3" /> 在 Browser 中打开
          </button>
        </div>
        <div
          className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/60 p-3"
          ref={mainRef}
        >
          <div
            className="relative max-h-full max-w-full overflow-hidden rounded-md bg-black shadow-2xl"
            style={{
              display:
                selectedTarget && frame?.targetId === selectedTargetId
                  ? undefined
                  : "none",
              aspectRatio: frame
                ? `${frame.width} / ${frame.height}`
                : undefined,
              width: "100%",
            }}
          >
            <canvas
              ref={canvasRef}
              role="img"
              aria-label={`Live preview of ${selectedTarget?.title || selectedTarget?.url || "page"}`}
              className="pointer-events-none block h-full w-full select-none object-contain"
              data-testid="automation-live-frame"
            />
            {pointer && pointerLeft && pointerTop ? (
              <div
                className="pointer-events-none absolute -translate-x-1 -translate-y-1 text-sky-400 drop-shadow"
                style={{ left: pointerLeft, top: pointerTop }}
              >
                <MousePointer2 className="h-4 w-4 fill-sky-400/30" />
                {selectedTarget.action === "click" ? (
                  <span className="absolute left-0 top-0 h-5 w-5 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full border border-sky-300" />
                ) : null}
              </div>
            ) : null}
            {selectedTarget?.previewState === "error" || decodeError ? (
              <div className="absolute inset-x-0 bottom-0 bg-rose-950/90 px-3 py-2 text-xs text-rose-200">
                画面中断：
                {decodeError || selectedTarget?.previewError || "未知错误"}
                （保留最后画面）
              </div>
            ) : null}
          </div>
          {!selectedTarget || frame?.targetId !== selectedTargetId ? (
            <div className="text-center text-xs text-slate-500">
              {selectedTarget?.previewState === "error"
                ? `画面不可用：${selectedTarget.previewError || "未知错误"}`
                : decodeError ||
                  (selectedTarget
                    ? "正在连接实时画面…"
                    : "选择左侧 Tab 查看实时画面")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
