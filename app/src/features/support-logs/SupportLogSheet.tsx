import {
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
} from "@ionic/react";
import { useCallback, useEffect, useState } from "react";

import {
  buildSupportLogBundle,
  downloadSupportLogBundle,
  shareSupportLogBundle,
} from "./support-log-export";
import {
  flushSupportLogs,
  recordSupportLogToStore,
} from "./support-log-recorder";
import { useSupportLogsInternal } from "./use-support-logs";

interface SupportLogSummary {
  eventCount: number | null;
  networkLabel: string;
  routeLabel: string;
  storageLabel: string;
  terminalLabel: string;
}

function resolveRouteLabel(route?: string): string {
  if (route) {
    return route;
  }
  if (typeof window !== "undefined") {
    return window.location.pathname;
  }
  return "-";
}

export function SupportLogSheet() {
  const {
    clearSupportLogs,
    closeSupportLogs,
    currentScope,
    isOpen,
    store,
  } = useSupportLogsInternal();
  const [summary, setSummary] = useState<SupportLogSummary>({
    eventCount: null,
    networkLabel: "-",
    routeLabel: "-",
    storageLabel: "-",
    terminalLabel: "-",
  });
  const [busyAction, setBusyAction] = useState<"share" | "download" | "clear" | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refreshSummary = useCallback(async () => {
    await flushSupportLogs();
    const records = await store.listRecent();
    const status = store.getStatus();
    const terminalEvents = records.filter((record) =>
      record.event.startsWith("terminal."),
    ).length;
    setSummary({
      eventCount: records.length,
      networkLabel:
        typeof navigator === "undefined"
          ? "-"
          : navigator.onLine
            ? "Online"
            : "Offline",
      routeLabel: resolveRouteLabel(currentScope.route),
      storageLabel:
        status.storageKind === "memory"
          ? "Memory only"
          : status.storageDegraded
            ? "Limited"
            : "IndexedDB",
      terminalLabel:
        currentScope.source === "terminal"
          ? `${currentScope.connectionStatus ?? "-"} / ${
              currentScope.runtimeStatus ?? "-"
            }`
          : `${terminalEvents} events`,
    });
  }, [currentScope, store]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setMessage(null);
    setSummary((current) => ({
      ...current,
      eventCount: null,
      routeLabel: resolveRouteLabel(currentScope.route),
      terminalLabel:
        currentScope.source === "terminal"
          ? `${currentScope.connectionStatus ?? "-"} / ${
              currentScope.runtimeStatus ?? "-"
            }`
          : "-",
    }));
    void refreshSummary();
  }, [isOpen, refreshSummary]);

  const exportBundle = async (method: "share" | "download") => {
    setBusyAction(method);
    setMessage(null);
    recordSupportLogToStore(store, "support.export.started", {
      method,
      scope: currentScope,
    });
    try {
      await flushSupportLogs();
      const bundle = await buildSupportLogBundle({
        store,
        scope: currentScope,
      });
      const result =
        method === "share"
          ? await shareSupportLogBundle(bundle)
          : downloadSupportLogBundle(bundle);
      recordSupportLogToStore(store, "support.export.completed", {
        eventCount: bundle.manifest.eventCount,
        filename: result.filename,
        method: result.method,
      });
      setMessage(result.warning ?? `已生成 ${result.filename}`);
      await refreshSummary();
    } catch (error) {
      recordSupportLogToStore(
        store,
        "support.export.failed",
        {
          errorName: error instanceof Error ? error.name : typeof error,
          errorMessage:
            error instanceof Error
              ? error.message
              : "Unable to create diagnostics file",
          method,
        },
        "error",
      );
      setMessage("Unable to create diagnostics file");
    } finally {
      setBusyAction(null);
    }
  };

  const handleClear = async () => {
    setBusyAction("clear");
    setMessage(null);
    try {
      await clearSupportLogs();
      setMessage("本地日志已清除");
      await refreshSummary();
    } finally {
      setBusyAction(null);
      setConfirmClear(false);
    }
  };

  return (
    <>
      <IonModal
        breakpoints={[0, 0.55, 0.9]}
        className="support-log-sheet"
        initialBreakpoint={0.9}
        isOpen={isOpen}
        onDidDismiss={closeSupportLogs}
      >
        <IonHeader>
          <IonToolbar>
            <IonTitle>日志上报</IonTitle>
            <IonButtons slot="end">
              <IonButton onClick={closeSupportLogs}>关闭</IonButton>
            </IonButtons>
          </IonToolbar>
        </IonHeader>
        <IonContent className="support-log-sheet__content">
          <section className="support-log-sheet__intro">
            <p>导出脱敏后的 App 诊断信息，用于定位登录、网络和终端连接问题。</p>
          </section>
          <IonList inset>
            <IonItem>
              <IonLabel>Route</IonLabel>
              <IonNote slot="end">{summary.routeLabel}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Network</IonLabel>
              <IonNote slot="end">{summary.networkLabel}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Events</IonLabel>
              <IonNote slot="end">{summary.eventCount ?? "-"}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Terminal</IonLabel>
              <IonNote slot="end">{summary.terminalLabel}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Storage</IonLabel>
              <IonNote slot="end">{summary.storageLabel}</IonNote>
            </IonItem>
          </IonList>
          {message ? (
            <p className="support-log-sheet__message">{message}</p>
          ) : null}
          <div className="support-log-sheet__actions">
            <IonButton
              disabled={busyAction !== null}
              expand="block"
              onClick={() => void exportBundle("share")}
            >
              {busyAction === "share" ? "处理中..." : "分享日志"}
            </IonButton>
            <IonButton
              disabled={busyAction !== null}
              expand="block"
              fill="outline"
              onClick={() => void exportBundle("download")}
            >
              {busyAction === "download" ? "处理中..." : "下载日志"}
            </IonButton>
            <IonButton
              color="danger"
              disabled={busyAction !== null}
              expand="block"
              fill="clear"
              onClick={() => setConfirmClear(true)}
            >
              清除本地日志
            </IonButton>
          </div>
        </IonContent>
      </IonModal>
      <IonAlert
        buttons={[
          {
            role: "cancel",
            text: "取消",
          },
          {
            handler: () => {
              void handleClear();
            },
            role: "destructive",
            text: "清除",
          },
        ]}
        header="清除本地日志"
        isOpen={confirmClear}
        message="这只会清除本地诊断日志，不会影响登录状态。"
        onDidDismiss={() => setConfirmClear(false)}
      />
    </>
  );
}
