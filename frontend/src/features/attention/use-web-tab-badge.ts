import { useMemoizedFn } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AttentionSnapshot } from "@runweave/shared/attention";
import { fetchAttentionSnapshot } from "../../services/attention";
import { HttpError } from "../../services/http";
import { fetchTerminalUnread } from "../../services/terminal/unread";
import { useTerminalWorkspaceStore } from "../terminal/state/workspace-store";

const POLL_INTERVAL_MS = 4_000;
const FAVICON_SIZE = 192;
const BADGE_CENTER_X = 148;
const BADGE_CENTER_Y = 44;
const BADGE_CUTOUT_RADIUS = 50;
const BADGE_DOT_RADIUS = 40;
const BADGE_COLOR = "#30d158";

const badgedFaviconCache = new Map<string, Promise<string>>();

function stripTabBadgePrefix(title: string): string {
  return title.replace(/^\(\d+(?:\s*·\s*(?:待接管|已完成))?\)\s+/u, "");
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load favicon image"));
    image.src = src;
  });
}

function buildBadgedFavicon(sourceHref: string): Promise<string> {
  const cached = badgedFaviconCache.get(sourceHref);
  if (cached) return cached;

  const task = (async () => {
    const canvas = document.createElement("canvas");
    canvas.width = FAVICON_SIZE;
    canvas.height = FAVICON_SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return sourceHref;

    try {
      const image = await loadImage(sourceHref);
      ctx.drawImage(image, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
    } catch {
      ctx.fillStyle = "#0d1015";
      ctx.beginPath();
      ctx.roundRect(16, 16, 160, 160, 36);
      ctx.fill();
    }

    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(BADGE_CENTER_X, BADGE_CENTER_Y, BADGE_CUTOUT_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = BADGE_COLOR;
    ctx.beginPath();
    ctx.arc(BADGE_CENTER_X, BADGE_CENTER_Y, BADGE_DOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    return canvas.toDataURL("image/png");
  })();

  badgedFaviconCache.set(sourceHref, task);
  return task;
}

export function useWebTabBadge(params: {
  apiBase: string;
  token: string | null;
  enabled: boolean;
}): void {
  const { apiBase, token, enabled } = params;
  const isElectron = window.electronAPI?.isElectron === true;
  const active = !isElectron && enabled && Boolean(apiBase && token);

  const {
    hasLoadedSessions,
    activeSessionId,
    completionMarkers,
    bellMarkers,
    terminalStateBySessionId,
  } = useTerminalWorkspaceStore(
    useShallow((state) => ({
      hasLoadedSessions: state.hasLoadedSessions,
      activeSessionId: state.activeSessionId,
      completionMarkers: state.completionMarkers,
      bellMarkers: state.bellMarkers,
      terminalStateBySessionId: state.terminalStateBySessionId,
    })),
  );

  const [attentionSnapshot, setAttentionSnapshot] = useState<AttentionSnapshot | null>(null);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useMemoizedFn(() => {
    if (!active || !token) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    void Promise.all([
      fetchAttentionSnapshot(apiBase, token, controller.signal),
      hasLoadedSessions
        ? Promise.resolve(null)
        : fetchTerminalUnread(apiBase, token, controller.signal).catch(() => null),
    ])
      .then(([attention, unread]) => {
        if (controller.signal.aborted) return;
        setAttentionSnapshot(attention);
        if (unread && Number.isSafeInteger(unread.count) && unread.count >= 0) {
          setUnreadCount(unread.count);
        } else if (hasLoadedSessions) {
          setUnreadCount(null);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof HttpError && [401, 403].includes(error.status)) {
          setAttentionSnapshot(null);
          setUnreadCount(null);
        }
      });
  });

  useEffect(() => {
    if (!active) {
      controllerRef.current?.abort();
      setAttentionSnapshot(null);
      setUnreadCount(null);
      return;
    }
    refresh();
    const timer = window.setInterval(refresh, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
      controllerRef.current?.abort();
    };
  }, [active, apiBase, hasLoadedSessions, refresh, token]);

  useEffect(() => {
    if (!active) return;
    refresh();
  }, [active, completionMarkers, refresh, terminalStateBySessionId]);

  const { totalCount, takeoverCount } = useMemo(() => {
    if (!active) return { totalCount: 0, takeoverCount: 0 };
    const takeoverIds = new Set<string>();
    const completedIds = new Set<string>();

    if (hasLoadedSessions) {
      for (const [id, hasBell] of Object.entries(bellMarkers)) {
        if (hasBell && id !== activeSessionId) takeoverIds.add(id);
      }
      for (const [id, revision] of Object.entries(completionMarkers)) {
        if (revision > 0) completedIds.add(id);
      }
      for (const slot of attentionSnapshot?.slots ?? []) {
        if (slot.state === "needs_action" || slot.state === "blocked") {
          if (
            slot.completionRevision === null ||
            (completionMarkers[slot.terminalSessionId] ?? 0) > 0
          ) {
            takeoverIds.add(slot.terminalSessionId);
          }
        }
      }
      const allIds = new Set([...takeoverIds, ...completedIds]);
      return { totalCount: allIds.size, takeoverCount: takeoverIds.size };
    }

    for (const slot of attentionSnapshot?.slots ?? []) {
      if (slot.state === "needs_action" || slot.state === "blocked") {
        takeoverIds.add(slot.terminalSessionId);
      } else if (slot.state === "completed") {
        completedIds.add(slot.terminalSessionId);
      }
    }
    const allIds = new Set([...takeoverIds, ...completedIds]);
    return {
      totalCount: Math.max(allIds.size, unreadCount ?? 0),
      takeoverCount: takeoverIds.size,
    };
  }, [
    active,
    activeSessionId,
    attentionSnapshot,
    bellMarkers,
    completionMarkers,
    hasLoadedSessions,
    unreadCount,
  ]);

  const baseTitleRef = useRef<string | null>(null);
  const faviconRef = useRef<{ link: HTMLLinkElement; originalHref: string } | null>(null);

  useEffect(() => {
    if (isElectron) return;
    baseTitleRef.current ??= stripTabBadgePrefix(document.title) || "Runweave";
    if (!faviconRef.current) {
      const link = document.querySelector<HTMLLinkElement>(
        'link[rel="icon"], link[rel="shortcut icon"]',
      );
      if (link) {
        faviconRef.current = {
          link,
          originalHref: link.getAttribute("href") || "/icons/icon-192.png",
        };
      }
    }

    const baseTitle = baseTitleRef.current;
    const favicon = faviconRef.current;
    let cancelled = false;

    if (totalCount > 0) {
      const statusLabel = takeoverCount > 0 ? "待接管" : "已完成";
      const nextTitle = `(${totalCount} · ${statusLabel}) ${baseTitle}`;
      if (document.title !== nextTitle) document.title = nextTitle;
      document.documentElement.dataset.runweaveUnreadCount = String(totalCount);
      document.documentElement.dataset.runweaveTabAttention =
        takeoverCount > 0 ? "takeover" : "completed";
      if (favicon) {
        void buildBadgedFavicon(favicon.originalHref).then((dataUrl) => {
          if (cancelled) return;
          if (favicon.link.getAttribute("href") !== dataUrl) {
            favicon.link.setAttribute("href", dataUrl);
          }
          favicon.link.dataset.runweaveUnreadBadge = "true";
        });
      }
    } else {
      if (document.title !== baseTitle) document.title = baseTitle;
      delete document.documentElement.dataset.runweaveUnreadCount;
      delete document.documentElement.dataset.runweaveTabAttention;
      if (favicon) {
        if (favicon.link.getAttribute("href") !== favicon.originalHref) {
          favicon.link.setAttribute("href", favicon.originalHref);
        }
        delete favicon.link.dataset.runweaveUnreadBadge;
      }
    }

    return () => {
      cancelled = true;
    };
  }, [isElectron, takeoverCount, totalCount]);

  useEffect(() => {
    if (isElectron) return;
    return () => {
      if (baseTitleRef.current && document.title !== baseTitleRef.current) {
        document.title = baseTitleRef.current;
      }
      delete document.documentElement.dataset.runweaveUnreadCount;
      delete document.documentElement.dataset.runweaveTabAttention;
      if (faviconRef.current) {
        faviconRef.current.link.setAttribute("href", faviconRef.current.originalHref);
        delete faviconRef.current.link.dataset.runweaveUnreadBadge;
      }
    };
  }, [isElectron]);
}
