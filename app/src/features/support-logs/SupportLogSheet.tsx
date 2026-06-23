import { useMemoizedFn } from "ahooks";
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
import { useEffect, useState } from "react";
import type { DiagnosticLogStatus } from "@runweave/shared";

import { APP_BUILD_ID, APP_VERSION } from "../../config/app-build-info";
import {
  getDiagnosticLogStatus,
  startDiagnosticLogs,
  stopDiagnosticLogs,
  toDiagnosticLogRecord,
} from "../../services/diagnostic-logs";
import { useCopyFeedback } from "../../hooks/use-copy-feedback";
import {
  flushSupportLogs,
  recordSupportLogToStore,
} from "./support-log-recorder";
import { useSupportLogsInternal } from "./use-support-logs";

function statusLabel(status: DiagnosticLogStatus): string {
  switch (status) {
    case "recording":
      return "记录中";
    case "ended":
      return "已结束";
    case "ready":
    default:
      return "可记录";
  }
}

function formatActionError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (
    message.includes("Failed to fetch") ||
    message.includes("NetworkError") ||
    message.includes("Load failed")
  ) {
    return `${action}失败：后端不可用`;
  }
  return message ? `${action}失败：${message}` : `${action}失败`;
}

export function SupportLogSheet() {
  const {
    clearSupportLogs,
    closeSupportLogs,
    currentScope,
    isOpen,
    store,
    uploadTarget,
  } = useSupportLogsInternal();
  const [status, setStatus] = useState<DiagnosticLogStatus>("ready");
  const [recordingStartedAt, setRecordingStartedAt] = useState<Date | null>(
    null,
  );
  const [serverDir, setServerDir] = useState<string | null>(null);
  const [serverLogFile, setServerLogFile] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    "start" | "stop" | "clear" | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const { copied, copyText } = useCopyFeedback();

  const refreshStatus = useMemoizedFn(async () => {
    if (!uploadTarget) {
      setStatus("ready");
      return;
    }
    try {
      const response = await getDiagnosticLogStatus(
        uploadTarget.apiBase,
        uploadTarget.accessToken,
      );
      setStatus(response.status);
      // Restore the recording window from the backend (source of truth) so a
      // page/WebView reload mid-recording does not lose the start boundary and
      // accidentally upload the entire retained log history.
      if (response.status === "recording" && response.startedAt) {
        setRecordingStartedAt(new Date(response.startedAt));
      } else if (response.status !== "recording") {
        setRecordingStartedAt(null);
      }
    } catch {
      // Status is best-effort; surface failures on the actual action instead.
    }
  });

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setMessage(null);
    void refreshStatus();
  }, [isOpen, refreshStatus]);

  const handleStart = useMemoizedFn(async () => {
    if (!uploadTarget) {
      return;
    }
    setBusyAction("start");
    setMessage(null);
    try {
      const response = await startDiagnosticLogs(
        uploadTarget.apiBase,
        uploadTarget.accessToken,
      );
      // Prefer the backend's authoritative start time so the upload window
      // matches the server's recording boundary exactly.
      setRecordingStartedAt(
        response.startedAt ? new Date(response.startedAt) : new Date(),
      );
      setServerDir(null);
      setServerLogFile(null);
      setStatus("recording");
      void recordSupportLogToStore(store, "diagnostic.recording.started", {
        scope: currentScope,
      });
      setMessage("已开始记录，请复现问题后点击结束并上报。");
    } catch (error) {
      setMessage(formatActionError("开始记录", error));
    } finally {
      setBusyAction(null);
    }
  });

  const handleStopAndUpload = useMemoizedFn(async () => {
    if (!uploadTarget) {
      return;
    }
    setBusyAction("stop");
    setMessage(null);
    try {
      // Without a known recording start the only safe scope would be the entire
      // retained history. Try to recover the window from the backend first; if
      // still unknown, refuse rather than over-collect, and ask for a restart.
      let since = recordingStartedAt;
      if (!since) {
        const response = await getDiagnosticLogStatus(
          uploadTarget.apiBase,
          uploadTarget.accessToken,
        );
        if (response.status === "recording" && response.startedAt) {
          since = new Date(response.startedAt);
          setRecordingStartedAt(since);
        } else if (response.status === "recording") {
          setBusyAction(null);
          setMessage(
            "无法确定本轮记录的开始时间（可能页面已重载），请重新开始记录后再上报，避免上传无关历史日志。",
          );
          return;
        }
      }
      void recordSupportLogToStore(store, "diagnostic.recording.stopping", {
        scope: currentScope,
      });
      await flushSupportLogs();
      const records = await store.listRecent(since ? { since } : undefined);
      const frontendLogs = records.map(toDiagnosticLogRecord);
      const result = await stopDiagnosticLogs(
        uploadTarget.apiBase,
        uploadTarget.accessToken,
        frontendLogs,
      );
      setStatus("ended");
      setRecordingStartedAt(null);
      setServerDir(result.files?.dir ?? null);
      setServerLogFile(result.files?.logsJsonl ?? null);
      setMessage(
        `已上报 ${result.logs.length} 条日志到服务端，可在服务端读取分析。`,
      );
    } catch (error) {
      // Persistence/transport may have failed after the backend already ended
      // recording. Refresh the real status so the UI reflects it, and tell the
      // user they can safely retry — stop is idempotent and won't lose logs.
      await refreshStatus();
      setMessage(
        `${formatActionError("结束并上报", error)}（可再次点击重试，不会丢失日志）`,
      );
    } finally {
      setBusyAction(null);
    }
  });

  const handleClear = useMemoizedFn(async () => {
    setBusyAction("clear");
    setMessage(null);
    try {
      await clearSupportLogs();
      setMessage("本地日志已清除");
    } finally {
      setBusyAction(null);
      setConfirmClear(false);
    }
  });

  const handleCopyLogFile = useMemoizedFn(async () => {
    const path = serverLogFile ?? serverDir;
    if (!path) {
      return;
    }
    const ok = await copyText(path);
    setMessage(ok ? "已复制日志文件路径" : "复制失败，请手动选择路径");
  });

  const isRecording = status === "recording";

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
            <p>
              开始记录后复现问题，结束时会把客户端与服务端日志统一上报到服务端本地目录，便于直接读取分析。
            </p>
          </section>
          <IonList inset>
            <IonItem>
              <IonLabel>状态</IonLabel>
              <IonNote slot="end">{statusLabel(status)}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Route</IonLabel>
              <IonNote slot="end">{currentScope.route ?? "-"}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>版本</IonLabel>
              <IonNote slot="end">{APP_VERSION}</IonNote>
            </IonItem>
            <IonItem>
              <IonLabel>Build</IonLabel>
              <IonNote slot="end">{APP_BUILD_ID}</IonNote>
            </IonItem>
            {serverLogFile || serverDir ? (
              <IonItem>
                <IonLabel position="stacked">服务端日志文件</IonLabel>
                <p className="support-log-sheet__server-dir">
                  {serverLogFile ?? serverDir}
                </p>
              </IonItem>
            ) : null}
          </IonList>
          {message ? (
            <p className="support-log-sheet__message">{message}</p>
          ) : null}
          {!uploadTarget ? (
            <p className="support-log-sheet__message">
              请先登录并连接本地电脑后再上报日志。
            </p>
          ) : null}
          <div className="support-log-sheet__actions">
            {isRecording ? (
              <IonButton
                disabled={busyAction !== null}
                expand="block"
                onClick={() => void handleStopAndUpload()}
              >
                {busyAction === "stop" ? "上报中..." : "结束并上报"}
              </IonButton>
            ) : (
              <IonButton
                disabled={busyAction !== null || !uploadTarget}
                expand="block"
                onClick={() => void handleStart()}
              >
                {busyAction === "start" ? "处理中..." : "开始记录"}
              </IonButton>
            )}
            {!isRecording && (serverLogFile || serverDir) ? (
              <IonButton
                disabled={busyAction !== null}
                expand="block"
                fill="outline"
                onClick={() => void handleCopyLogFile()}
              >
                {copied ? "已复制路径" : "复制日志文件名"}
              </IonButton>
            ) : null}
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
