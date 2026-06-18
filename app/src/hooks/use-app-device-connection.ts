import { useCallback, useEffect, useRef, useState } from "react";

import { getBackendHealth } from "../services/device-health";

export type AppDeviceConnectionStatus = "checking" | "online" | "offline";

export interface AppDeviceConnectionSnapshot {
  status: AppDeviceConnectionStatus;
  connectionId: string | null;
  apiBaseHost: string;
  checkedAt: number | null;
  lastSeenAt: number | null;
  latencyMs: number | null;
  reason:
    | "initial"
    | "health-ok"
    | "network-unreachable"
    | "timeout"
    | "http-error"
    | "terminal-events-connected"
    | "terminal-events-close";
  message: string;
}

const OFFLINE_RETRY_DELAYS_MS = [5000, 15000, 30000, 60000, 120000];

function resolveApiBaseHost(apiBase: string): string {
  try {
    return new URL(apiBase).host;
  } catch {
    return apiBase.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || "local";
  }
}

function buildInitialSnapshot(
  apiBase: string,
  connectionId: string | null,
): AppDeviceConnectionSnapshot {
  return {
    status: "checking",
    connectionId,
    apiBaseHost: resolveApiBaseHost(apiBase),
    checkedAt: null,
    lastSeenAt: null,
    latencyMs: null,
    reason: "initial",
    message: "Checking computer",
  };
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function isPageActive(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  if (document.visibilityState !== "visible") {
    return false;
  }
  return typeof document.hasFocus !== "function" || document.hasFocus();
}

export function useAppDeviceConnection({
  apiBase,
  connectionId,
  enabled,
}: {
  apiBase: string;
  connectionId: string | null;
  enabled: boolean;
}) {
  const [deviceConnection, setDeviceConnection] =
    useState<AppDeviceConnectionSnapshot>(() =>
      buildInitialSnapshot(apiBase, connectionId),
    );
  const snapshotRef = useRef(deviceConnection);
  const activeProbeKeyRef = useRef("");
  const retryTimerRef = useRef<number | null>(null);
  const offlineAttemptRef = useRef(0);
  const [pageActive, setPageActive] = useState(() => isPageActive());
  const pageActiveRef = useRef(pageActive);
  const currentProbeKey = `${connectionId ?? ""}\u0000${apiBase}`;

  useEffect(() => {
    snapshotRef.current = deviceConnection;
  }, [deviceConnection]);

  useEffect(() => {
    pageActiveRef.current = pageActive;
  }, [pageActive]);

  useEffect(() => {
    activeProbeKeyRef.current = currentProbeKey;
    offlineAttemptRef.current = 0;
    setDeviceConnection(buildInitialSnapshot(apiBase, connectionId));
  }, [apiBase, connectionId, currentProbeKey]);

  const isCurrentProbe = useCallback(
    (probeKey: string) => activeProbeKeyRef.current === probeKey,
    [],
  );

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const markDeviceOnline = useCallback(
    (reason: AppDeviceConnectionSnapshot["reason"]) => {
      const now = Date.now();
      offlineAttemptRef.current = 0;
      clearRetryTimer();
      setDeviceConnection((current) => ({
        ...current,
        status: "online",
        connectionId,
        apiBaseHost: resolveApiBaseHost(apiBase),
        checkedAt: now,
        lastSeenAt: now,
        latencyMs: reason === "health-ok" ? current.latencyMs : null,
        reason,
        message: "Computer online",
      }));
    },
    [apiBase, clearRetryTimer, connectionId],
  );

  const markDeviceOffline = useCallback(
    (reason: AppDeviceConnectionSnapshot["reason"], message: string) => {
      const now = Date.now();
      setDeviceConnection((current) => ({
        ...current,
        status: "offline",
        connectionId,
        apiBaseHost: resolveApiBaseHost(apiBase),
        checkedAt: now,
        latencyMs: null,
        reason,
        message,
      }));
    },
    [apiBase, connectionId],
  );

  const probeDeviceConnection = useCallback(async () => {
    const probeApiBase = apiBase;
    const probeConnectionId = connectionId;
    const probeKey = currentProbeKey;
    clearRetryTimer();
    const wasOffline = snapshotRef.current.status === "offline";
    if (!wasOffline) {
      setDeviceConnection((current) => ({
        ...current,
        status: "checking",
        connectionId: probeConnectionId,
        apiBaseHost: resolveApiBaseHost(probeApiBase),
        reason: "initial",
        message: "Checking computer",
      }));
    }

    const result = await getBackendHealth(probeApiBase);
    if (!isCurrentProbe(probeKey)) {
      return snapshotRef.current;
    }
    const now = Date.now();
    if (result.ok) {
      offlineAttemptRef.current = 0;
      const nextSnapshot: AppDeviceConnectionSnapshot = {
        status: "online",
        connectionId: probeConnectionId,
        apiBaseHost: resolveApiBaseHost(probeApiBase),
        checkedAt: now,
        lastSeenAt: now,
        latencyMs: result.latencyMs,
        reason: "health-ok",
        message: "Computer online",
      };
      setDeviceConnection(nextSnapshot);
      return nextSnapshot;
    }

    const failure = result.failure;
    const reason =
      failure?.kind === "timeout"
        ? "timeout"
        : failure?.kind === "http-error" || failure?.kind === "auth-expired"
          ? "http-error"
          : "network-unreachable";
    const nextSnapshot: AppDeviceConnectionSnapshot = {
      ...snapshotRef.current,
      status: "offline",
      connectionId: probeConnectionId,
      apiBaseHost: resolveApiBaseHost(probeApiBase),
      checkedAt: now,
      latencyMs: result.latencyMs,
      reason,
      message:
        reason === "http-error"
          ? "Computer reached but unavailable"
          : "Local computer unavailable",
    };
    setDeviceConnection(nextSnapshot);
    return nextSnapshot;
  }, [apiBase, clearRetryTimer, connectionId, currentProbeKey, isCurrentProbe]);

  const refreshDeviceConnection = useCallback(async () => {
    offlineAttemptRef.current = 0;
    return probeDeviceConnection();
  }, [probeDeviceConnection]);

  useEffect(() => {
    if (!enabled) {
      clearRetryTimer();
      return;
    }
    void refreshDeviceConnection();
    return () => {
      clearRetryTimer();
    };
  }, [clearRetryTimer, enabled, refreshDeviceConnection]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const probeOnActive = () => {
      const nextActive = isPageActive();
      setPageActive(nextActive);
      if (nextActive) {
        void refreshDeviceConnection();
      }
    };
    const markInactive = () => {
      pageActiveRef.current = false;
      setPageActive(false);
      clearRetryTimer();
    };
    const handleVisibilityChange = () => {
      if (isDocumentVisible()) {
        probeOnActive();
      } else {
        markInactive();
      }
    };
    const handlePageShow = () => {
      probeOnActive();
    };
    const handleOnline = () => {
      if (pageActiveRef.current) {
        void refreshDeviceConnection();
      }
    };
    const handlePageHide = () => {
      markInactive();
    };

    if (!isPageActive()) {
      markInactive();
    }

    window.addEventListener("focus", probeOnActive);
    window.addEventListener("blur", markInactive);
    window.addEventListener("online", handleOnline);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", probeOnActive);
      window.removeEventListener("blur", markInactive);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [clearRetryTimer, enabled, refreshDeviceConnection]);

  useEffect(() => {
    clearRetryTimer();
    if (
      !enabled ||
      !pageActive ||
      deviceConnection.status !== "offline" ||
      !isDocumentVisible()
    ) {
      return;
    }

    const delayMs =
      OFFLINE_RETRY_DELAYS_MS[
        Math.min(offlineAttemptRef.current, OFFLINE_RETRY_DELAYS_MS.length - 1)
      ];
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      if (!pageActiveRef.current || !isDocumentVisible()) {
        clearRetryTimer();
        return;
      }
      offlineAttemptRef.current += 1;
      void probeDeviceConnection();
    }, delayMs);

    return () => {
      clearRetryTimer();
    };
  }, [
    clearRetryTimer,
    deviceConnection.checkedAt,
    deviceConnection.status,
    enabled,
    pageActive,
    probeDeviceConnection,
  ]);

  return {
    deviceConnection,
    markDeviceOnline,
    markDeviceOffline,
    refreshDeviceConnection,
  };
}
