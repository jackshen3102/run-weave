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

interface DisplayFrame extends TerminalBrowserAutomationFrame {
  objectUrl: string;
}

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

function acknowledgeFrame(frame: DisplayFrame | null): void {
  if (!frame) {
    return;
  }
  void window.electronAPI?.terminalBrowserAutomationAcknowledgeFrame?.({
    targetId: frame.targetId,
    sequence: frame.sequence,
  });
}

export function TerminalBrowserAutomationTool({
  active,
  sessions,
}: TerminalBrowserAutomationToolProps) {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [mainMaxEdge, setMainMaxEdge] = useState(640);
  const [documentVisible, setDocumentVisible] = useState(
    document.visibilityState === "visible",
  );
  const frameRef = useRef<DisplayFrame | null>(null);
  const selectedTargetIdRef = useRef<string | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const activateBrowser = useTerminalPreviewStore(
    (state) => state.activateBrowser,
  );

  const replaceFrame = useMemoizedFn((next: DisplayFrame | null) => {
    const previous = frameRef.current;
    frameRef.current = next;
    setFrame(next);
    if (previous && previous.objectUrl !== next?.objectUrl) {
      URL.revokeObjectURL(previous.objectUrl);
    }
  });

  const handleFrame = useMemoizedFn(
    (incoming: TerminalBrowserAutomationFrame) => {
      if (!active || incoming.targetId !== selectedTargetIdRef.current) {
        void window.electronAPI?.terminalBrowserAutomationAcknowledgeFrame?.({
          targetId: incoming.targetId,
          sequence: incoming.sequence,
        });
        return;
      }
      const bytes = Uint8Array.from(incoming.bytes);
      replaceFrame({
        ...incoming,
        bytes,
        objectUrl: URL.createObjectURL(
          new Blob([bytes], { type: incoming.mimeType }),
        ),
      });
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
      acknowledgeFrame(frameRef.current);
      replaceFrame(null);
      void window.electronAPI?.terminalBrowserAutomationSetViewState?.({
        visible: false,
        selectedTargetId: null,
        mainMaxEdge: 1,
      });
    };
  }, [handleFrame, replaceFrame]);

  useEffect(() => {
    const onVisibilityChange = () => {
      setDocumentVisible(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

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
        Math.min(640, Math.max(1, Math.round(Math.max(width, height)))),
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const targets = snapshot.targets;
    const selectedStillExists = targets.some(
      (target) => target.targetId === selectedTargetId,
    );
    const latestActionTarget = [...targets]
      .filter((target) => target.action !== "idle")
      .sort(
        (left, right) => (right.actionUntil ?? 0) - (left.actionUntil ?? 0),
      )[0];
    let nextTargetId = selectedTargetId;
    if (!selectedStillExists) {
      nextTargetId =
        latestActionTarget?.targetId ?? targets[0]?.targetId ?? null;
      setPinned(false);
    } else if (!pinned && latestActionTarget) {
      nextTargetId = latestActionTarget.targetId;
    }
    if (nextTargetId !== selectedTargetId) {
      setSelectedTargetId(nextTargetId);
    }
  }, [pinned, selectedTargetId, snapshot]);

  useEffect(() => {
    selectedTargetIdRef.current = selectedTargetId;
    acknowledgeFrame(frameRef.current);
    replaceFrame(null);
  }, [replaceFrame, selectedTargetId]);

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
  useEffect(() => {
    if (selectedTarget?.previewState !== "error" || !frameRef.current) {
      return;
    }
    const timer = window.setTimeout(() => {
      acknowledgeFrame(frameRef.current);
      replaceFrame(null);
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [replaceFrame, selectedTarget?.previewState]);

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
  const onFrameSettled = useMemoizedFn(() => {
    acknowledgeFrame(frameRef.current);
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
          {selectedTarget && frame ? (
            <div
              className="relative max-h-full max-w-full overflow-hidden rounded-md bg-black shadow-2xl"
              style={{
                aspectRatio: `${frame.width} / ${frame.height}`,
                width: "100%",
              }}
            >
              <img
                alt={`Live preview of ${selectedTarget.title || selectedTarget.url}`}
                className="pointer-events-none h-full w-full select-none object-contain"
                data-testid="automation-live-frame"
                draggable={false}
                key={frame.objectUrl}
                src={frame.objectUrl}
                onError={onFrameSettled}
                onLoad={onFrameSettled}
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
              {selectedTarget.previewState === "error" ? (
                <div className="absolute inset-x-0 bottom-0 bg-rose-950/90 px-3 py-2 text-xs text-rose-200">
                  画面中断：{selectedTarget.previewError || "未知错误"}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="text-center text-xs text-slate-500">
              {selectedTarget?.previewState === "error"
                ? `画面不可用：${selectedTarget.previewError || "未知错误"}`
                : selectedTarget
                  ? "正在连接实时画面…"
                  : "选择左侧 Tab 查看实时画面"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
