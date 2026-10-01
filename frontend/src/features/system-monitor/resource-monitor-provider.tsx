import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMemoizedFn } from "ahooks";
import type {
  ResourceMonitorResponse,
  ResourceAlert,
} from "@runweave/shared/resource-monitor";
import { resourceMonitorApi } from "../../services/resource-monitor";
import { HttpError } from "../../services/http";

function savedNotificationPreference(): boolean {
  try {
    return (
      localStorage.getItem("runweave:resource-mac-notifications") === "true"
    );
  } catch {
    return false;
  }
}
interface ResourceContext {
  data: ResourceMonitorResponse | null;
  error: string | null;
  unsupportedBackend: boolean;
  refresh: () => void;
  apiBase: string;
  token: string | null;
  macNotifications: boolean;
  setMacNotifications: (value: boolean) => void;
  notificationError: string | null;
  notice: ResourceAlert | null;
  dismissNotice: () => void;
  applySettings: (settings: ResourceMonitorResponse["settings"]) => void;
  applyRemoteControl: (
    permission: ResourceMonitorResponse["remoteControl"],
  ) => void;
  snooze: (alertId: string) => Promise<void>;
}
const Context = createContext<ResourceContext | null>(null);
export function useResources(): ResourceContext {
  const value = useContext(Context);
  if (!value) throw new Error("Resource monitor provider required");
  return value;
}
export function ResourceMonitorProvider(props: {
  apiBase: string;
  token: string | null;
  connectionId: string;
  children: ReactNode;
}) {
  const [data, setData] = useState<ResourceMonitorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupportedBackend, setUnsupportedBackend] = useState(false);
  const [macNotifications, setMac] = useState(savedNotificationPreference);
  const [notificationError, setNotificationError] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<ResourceAlert | null>(null);
  const lastPoll = useRef(0);
  const sessionSeen = useRef(new Set<string>());
  const pollRef = useRef<() => void>(() => {});
  const setMacNotifications = useMemoizedFn((value: boolean) => {
    try {
      localStorage.setItem(
        "runweave:resource-mac-notifications",
        String(value),
      );
    } catch {
      throw new Error("无法保存此设备的通知偏好");
    }
    setMac(value);
    setNotificationError(null);
  });
  const refresh = useMemoizedFn(() => pollRef.current());
  const dismissNotice = useMemoizedFn(() => setNotice(null));
  const applySettings = useMemoizedFn(
    (settings: ResourceMonitorResponse["settings"]) => {
      setData((current) =>
        current
          ? {
              ...current,
              settings,
              status: !settings.monitorEnabled ? "disabled" : "warming-up",
              alerts: [],
              canTerminate: false,
            }
          : current,
      );
      setNotice(null);
    },
  );
  const snooze = useMemoizedFn(async (alertId: string) => {
    if (!props.token) return;
    const appKey = data?.alerts.find(
      (alert) => alert.alertId === alertId,
    )?.appKey;
    try {
      await resourceMonitorApi(props.apiBase, props.token).snooze(alertId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
    setData((current) =>
      current
        ? {
            ...current,
            alerts: current.alerts.filter((alert) =>
              appKey ? alert.appKey !== appKey : alert.alertId !== alertId,
            ),
          }
        : current,
    );
    setNotice((current) =>
      current?.alertId === alertId || (appKey && current?.appKey === appKey)
        ? null
        : current,
    );
  });
  useEffect(() => {
    if (!props.token) return;
    let stopped = false;
    let polling = false;
    const controller = new AbortController();
    const poll = async () => {
      const desktopBackground =
        macNotifications && window.electronAPI?.isElectron === true;
      if (
        stopped ||
        polling ||
        (document.hidden && !desktopBackground) ||
        Date.now() - lastPoll.current < 60_000
      )
        return;
      polling = true;
      lastPoll.current = Date.now();
      try {
        const next = await resourceMonitorApi(
          props.apiBase,
          props.token!,
        ).snapshot(controller.signal);
        if (stopped) return;
        setData(next);
        setError(null);
        setUnsupportedBackend(false);
        const key = `runweave:resource-seen:${next.hostId}`;
        let seen: string[] = [];
        try {
          const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
          if (Array.isArray(value))
            seen = value
              .filter((id): id is string => typeof id === "string")
              .slice(-200);
        } catch {
          /* session fallback */
        }
        for (const alert of next.alerts) {
          if (
            seen.includes(alert.alertId) ||
            sessionSeen.current.has(`${next.hostId}:${alert.alertId}`)
          )
            continue;
          sessionSeen.current.add(`${next.hostId}:${alert.alertId}`);
          if (sessionSeen.current.size > 200)
            sessionSeen.current.delete(
              sessionSeen.current.values().next().value!,
            );
          seen.push(alert.alertId);
          seen = seen.slice(-200);
          // Mark before presentation so refresh/re-mount cannot repeatedly notify.
          try {
            localStorage.setItem(key, JSON.stringify(seen));
          } catch {
            /* current flight still de-duplicates */
          }
          if (desktopBackground) {
            try {
              const result =
                await window.electronAPI?.showResourceNotification?.({
                  connectionId: props.connectionId,
                  hostId: next.hostId,
                  alertId: alert.alertId,
                  appKey: alert.appKey,
                  title: `${alert.appName} ${alert.ruleId === "energy" ? "能耗影响较高" : "内存占用较大"}`,
                  body:
                    alert.ruleId === "energy"
                      ? "近 5 分钟多次检测到高占用"
                      : "近 5 分钟多次检测到较大内存占用；内存不代表耗电量",
                });
              if (stopped) return;
              if (
                result === "failed" ||
                result === "unavailable" ||
                result === undefined
              )
                setNotificationError(
                  "Mac 系统通知不可用或投递失败，请检查系统通知设置；应用内提醒仍保留",
                );
            } catch {
              if (!stopped)
                setNotificationError("Mac 系统通知投递失败，应用内提醒仍保留");
            }
          }
          // macOS may suppress a submitted notification; keep the app fallback.
          if (!stopped) setNotice(alert);
        }
        setNotice((current) =>
          current &&
          next.alerts.some((alert) => alert.alertId === current.alertId)
            ? current
            : null,
        );
      } catch (cause) {
        if (stopped) return;
        setUnsupportedBackend(
          cause instanceof HttpError && cause.status === 404,
        );
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        polling = false;
      }
    };
    pollRef.current = () => void poll();
    void poll();
    const timer = window.setInterval(() => void poll(), 60_000);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      pollRef.current = () => {};
    };
  }, [props.apiBase, props.token, props.connectionId, macNotifications]);
  return (
    <Context.Provider
      value={{
        data,
        error,
        unsupportedBackend,
        refresh,
        apiBase: props.apiBase,
        token: props.token,
        macNotifications,
        setMacNotifications,
        notificationError,
        notice,
        dismissNotice,
        applySettings,
        applyRemoteControl: (remoteControl) =>
          setData((current) =>
            current ? { ...current, remoteControl } : current,
          ),
        snooze,
      }}
    >
      {props.children}
    </Context.Provider>
  );
}
