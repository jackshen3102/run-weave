import { useMemoizedFn } from "ahooks";
import { Capacitor } from "@capacitor/core";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  installSupportLogRecorder,
  recordSupportLog,
  recordSupportLogToStore,
} from "./support-log-recorder";
import { APP_BUILD_ID, APP_VERSION } from "../../config/app-build-info";
import { createSupportLogStore } from "./support-log-store";
import type {
  SupportLogDefaultContext,
  SupportLogScope,
} from "./support-log-types";
import { SupportLogContext } from "./use-support-logs";
import type { SupportLogUploadTarget } from "./use-support-logs";

const DEFAULT_SCOPE: SupportLogScope = { source: "unknown" };

function getApiBaseHost(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.location.host;
}

function createDefaultContext(): SupportLogDefaultContext {
  if (typeof window === "undefined") {
    return {
      appBuildId: APP_BUILD_ID,
      appVersion: APP_VERSION,
      platform: Capacitor.getPlatform(),
    };
  }

  return {
    appBuildId: APP_BUILD_ID,
    appVersion: APP_VERSION,
    platform: Capacitor.getPlatform(),
    route: window.location.pathname,
    apiBaseHost: getApiBaseHost(),
    online: navigator.onLine,
    userAgent: navigator.userAgent,
  };
}

function errorFields(error: Error): Record<string, unknown> {
  return {
    errorName: error.name,
    errorMessage: error.message,
    stack: error.stack?.split("\n").slice(0, 6).join("\n"),
  };
}

function unknownErrorFields(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return errorFields(reason);
  }
  return {
    errorName: typeof reason,
    errorMessage: String(reason),
  };
}

export function SupportLogProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef(createSupportLogStore());
  const [isOpen, setIsOpen] = useState(false);
  const [currentScope, setCurrentScope] =
    useState<SupportLogScope>(DEFAULT_SCOPE);
  // Upload credentials are kept in state only; never written into log scope or
  // fields so the access token is never persisted or uploaded as log content.
  const [uploadTarget, setUploadTarget] =
    useState<SupportLogUploadTarget | null>(null);

  useEffect(() => {
    const uninstall = installSupportLogRecorder({
      store: storeRef.current,
      resolveDefaultContext: createDefaultContext,
    });
    recordSupportLog("app.startup.ready");

    const handleError = (event: ErrorEvent) => {
      recordSupportLog(
        "app.error.unhandled",
        event.error instanceof Error
          ? errorFields(event.error)
          : {
              errorName: "ErrorEvent",
              errorMessage: event.message,
            },
        "error",
      );
    };
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      recordSupportLog(
        "app.promise.unhandled_rejection",
        unknownErrorFields(event.reason),
        "error",
      );
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
      uninstall();
    };
  }, []);

  const openSupportLogs = useMemoizedFn((scope: SupportLogScope) => {
    setCurrentScope(scope);
    setIsOpen(true);
    recordSupportLogToStore(storeRef.current, "support.sheet.opened", {
      scope,
    });
  });

  const closeSupportLogs = useMemoizedFn(() => {
    setIsOpen(false);
  });

  const clearSupportLogs = useMemoizedFn(async () => {
    await storeRef.current.clear();
    recordSupportLogToStore(storeRef.current, "support.logs.cleared");
  });

  const contextValue = useMemo(
    () => ({
      clearSupportLogs,
      closeSupportLogs,
      currentScope,
      isOpen,
      openSupportLogs,
      setUploadTarget,
      uploadTarget,
      store: storeRef.current,
    }),
    [
      clearSupportLogs,
      closeSupportLogs,
      currentScope,
      isOpen,
      openSupportLogs,
      uploadTarget,
    ],
  );

  return (
    <SupportLogContext.Provider value={contextValue}>
      {children}
    </SupportLogContext.Provider>
  );
}
